// ===================== 配置项：替换成你自己的 =====================
const SUPABASE_URL = "https://pwjzstypijyspkdrcrxc.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB3anpzdHlwaWp5c3BrZHJjcnhjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQxMDQ0MTQsImV4cCI6MjA5OTY4MDQxNH0.UZ4C1ehOSZv6QWO-Cj6EDV8-viCc2KJX5KSwOGJeE0E";

// 初始化 Supabase 客户端
const supabase = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// 生成本地玩家唯一ID（刷新不丢失，用于断线重连）
let myPlayerId = localStorage.getItem("card_game_pid");
if (!myPlayerId) {
  myPlayerId = "p_" + Math.random().toString(36).slice(2, 10);
  localStorage.setItem("card_game_pid", myPlayerId);
}

let currentRoomId = null;
let myName = "";
let realtimeChannel = null;

// DOM 元素（和原代码完全一致，兼容你的页面结构）
const loginBox = document.getElementById("loginBox");
const gameBox = document.getElementById("gameBox");
const nameInput = document.getElementById("nameInput");
const startBtn = document.getElementById("startBtn");
const statusEl = document.getElementById("status");
const turnInfoEl = document.getElementById("turnInfo");
const deckInfoEl = document.getElementById("deckInfo");
const handEl = document.getElementById("hand");
const drawBtn = document.getElementById("drawBtn");
const chatBox = document.getElementById("chatBox");
const chatInput = document.getElementById("chatInput");
const sendChatBtn = document.getElementById("sendChatBtn");

// ========== 游戏核心逻辑 ==========
startBtn.onclick = () => {
  const name = nameInput.value.trim();
  if (!name) return alert("请输入昵称");
  myName = name;
  loginBox.classList.add("hidden");
  gameBox.classList.remove("hidden");
  statusEl.textContent = "正在匹配对手...";
  startMatch();
};

// 自动匹配：找等待中的房间，没有就创建
async function startMatch() {
  // 1. 查询等待中的房间
  const { data: waitingRooms } = await supabase
    .from("rooms")
    .select("id")
    .eq("status", "waiting")
    .limit(1);

  let roomId;
  if (waitingRooms.length > 0) {
    // 加入已有房间
    roomId = waitingRooms[0].id;
    await joinRoom(roomId);
    // 更新房间状态为游戏中，设置房主为先手
    await supabase
      .from("rooms")
      .update({ status: "playing" })
      .eq("id", roomId);
  } else {
    // 创建新房间，自己当房主
    roomId = await createRoom();
  }

  currentRoomId = roomId;
  subscribeRoom(roomId); // 订阅房间实时变化
  addSystemMessage("已进入房间，等待对手...");
}

// 创建新房间并初始化牌组
async function createRoom() {
  // 生成20张数字牌并洗牌
  const deck = [];
  for (let i = 1; i <= 20; i++) deck.push(i);
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }

  // 创建房间
  const { data: room } = await supabase
    .from("rooms")
    .insert({ deck, status: "waiting", turn: myPlayerId })
    .select("id")
    .single();

  // 加入房间并发初始手牌
  const myHand = deck.splice(0, 3);
  await supabase.from("room_players").insert({
    room_id: room.id,
    player_id: myPlayerId,
    name: myName,
    hand: myHand
  });

  // 更新剩余牌库
  await supabase.from("rooms").update({ deck }).eq("id", room.id);
  return room.id;
}

// 加入已有房间
async function joinRoom(roomId) {
  const { data: room } = await supabase
    .from("rooms")
    .select("deck, turn")
    .eq("id", roomId)
    .single();

  // 发3张初始手牌
  const deck = room.deck;
  const myHand = deck.splice(0, 3);

  await supabase.from("room_players").insert({
    room_id: roomId,
    player_id: myPlayerId,
    name: myName,
    hand: myHand
  });

  // 更新剩余牌库
  await supabase.from("rooms").update({ deck }).eq("id", roomId);
}

// 订阅房间实时数据变化
function subscribeRoom(roomId) {
  realtimeChannel = supabase.channel("room-" + roomId)
    // 监听玩家数据变化（出牌、抽牌）
    .on("postgres_changes", {
      event: "*",
      schema: "public",
      table: "room_players",
      filter: `room_id=eq.${roomId}`
    }, () => refreshGameUI())
    // 监听房间状态变化
    .on("postgres_changes", {
      event: "*",
      schema: "public",
      table: "rooms",
      filter: `id=eq.${roomId}`
    }, () => refreshGameUI())
    // 监听新聊天消息
    .on("postgres_changes", {
      event: "INSERT",
      schema: "public",
      table: "chats",
      filter: `room_id=eq.${roomId}`
    }, (payload) => {
      const msg = payload.new;
      addChatMessage(msg.name, msg.message);
    })
    .subscribe();
}

// 刷新游戏界面
async function refreshGameUI() {
  if (!currentRoomId) return;

  // 获取房间信息
  const { data: room } = await supabase
    .from("rooms")
    .select("*")
    .eq("id", currentRoomId)
    .single();

  // 获取所有玩家
  const { data: players } = await supabase
    .from("room_players")
    .select("*")
    .eq("room_id", currentRoomId);

  if (!room || !players) return;

  const me = players.find(p => p.player_id === myPlayerId);
  const turnPlayer = players.find(p => p.player_id === room.turn);
  const opponent = players.find(p => p.player_id !== myPlayerId);

  statusEl.textContent = opponent ? "对战中" : "等待对手加入";
  turnInfoEl.textContent = `当前回合：${turnPlayer ? turnPlayer.name : "等待中"}`;
  deckInfoEl.textContent = `牌库剩余：${room.deck.length}`;

  // 渲染自己的手牌
  handEl.innerHTML = "";
  if (me) {
    me.hand.forEach(card => {
      const btn = document.createElement("button");
      btn.className = "card";
      btn.textContent = card;
      btn.disabled = room.turn !== myPlayerId; // 不是自己回合不能出牌
      btn.onclick = () => playCard(card);
      handEl.appendChild(btn);
    });
  }

  // 游戏开始提示
  if (room.status === "playing" && opponent && !statusEl.dataset.started) {
    addSystemMessage("对手已加入，游戏开始！");
    statusEl.dataset.started = "1";
  }
}

// 抽牌
drawBtn.onclick = async () => {
  if (!currentRoomId) return;
  const { data: room } = await supabase
    .from("rooms")
    .select("deck, turn")
    .eq("id", currentRoomId)
    .single();

  if (room.turn !== myPlayerId) return addSystemMessage("还没轮到你");
  if (room.deck.length === 0) return addSystemMessage("牌库已经没有牌了");

  // 抽一张牌
  const newDeck = [...room.deck];
  const card = newDeck.pop();

  // 更新自己的手牌
  const { data: me } = await supabase
    .from("room_players")
    .select("hand")
    .eq("room_id", currentRoomId)
    .eq("player_id", myPlayerId)
    .single();

  const newHand = [...me.hand, card];
  await supabase
    .from("room_players")
    .update({ hand: newHand })
    .eq("room_id", currentRoomId)
    .eq("player_id", myPlayerId);

  // 更新牌库
  await supabase.from("rooms").update({ deck: newDeck }).eq("id", currentRoomId);
  addSystemMessage("你抽了一张牌");
};

// 出牌
async function playCard(card) {
  const { data: room } = await supabase
    .from("rooms")
    .select("turn")
    .eq("id", currentRoomId)
    .single();
  if (room.turn !== myPlayerId) return;

  // 移除打出的牌
  const { data: me } = await supabase
    .from("room_players")
    .select("hand")
    .eq("room_id", currentRoomId)
    .eq("player_id", myPlayerId)
    .single();

  const newHand = me.hand.filter(c => c !== card);
  await supabase
    .from("room_players")
    .update({ hand: newHand })
    .eq("room_id", currentRoomId)
    .eq("player_id", myPlayerId);

  // 切换回合给对手
  const { data: players } = await supabase
    .from("room_players")
    .select("player_id")
    .eq("room_id", currentRoomId);

  const opponent = players.find(p => p.player_id !== myPlayerId);
  if (opponent) {
    await supabase
      .from("rooms")
      .update({ turn: opponent.player_id })
      .eq("id", currentRoomId);
  }

  addSystemMessage(`你打出了 ${card}，轮到对手`);
}

// ========== 聊天逻辑 ==========
sendChatBtn.onclick = sendChat;
chatInput.addEventListener("keydown", e => {
  if (e.key === "Enter") sendChat();
});

async function sendChat() {
  const message = chatInput.value.trim();
  if (!message || !currentRoomId) return;
  await supabase.from("chats").insert({
    room_id: currentRoomId,
    name: myName,
    message
  });
  chatInput.value = "";
}

function addChatMessage(name, message) {
  const div = document.createElement("div");
  div.className = "chat-line";
  div.textContent = `${name}: ${message}`;
  chatBox.appendChild(div);
  chatBox.scrollTop = chatBox.scrollHeight;
}

function addSystemMessage(msg) {
  const div = document.createElement("div");
  div.className = "system-message";
  div.textContent = `[系统] ${msg}`;
  chatBox.appendChild(div);
  chatBox.scrollTop = chatBox.scrollHeight;
}

// 页面关闭时清理订阅
window.addEventListener("beforeunload", () => {
  if (realtimeChannel) supabase.removeChannel(realtimeChannel);
});
