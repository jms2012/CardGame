// ===================== 配置项：替换成你自己的 =====================
const SUPABASE_URL = "https://pwjzstypijyspkdrcrxc.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB3anpzdHlwaWp5c3BrZHJjcnhjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQxMDQ0MTQsImV4cCI6MjA5OTY4MDQxNH0.UZ4C1ehOSZv6QWO-Cj6EDV8-viCc2KJX5KSwOGJeE0E";

const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// 生成本地玩家唯一ID
let myPlayerId = localStorage.getItem("card_game_pid");
if (!myPlayerId) {
  myPlayerId = "p_" + Math.random().toString(36).slice(2, 10);
  localStorage.setItem("card_game_pid", myPlayerId);
}

// 全局状态
let currentRoomId = null;
let myName = "";
let realtimeChannel = null;
let currentRoomData = null;
let currentPlayersData = [];

// DOM元素
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

// ========== 入口：开始匹配（增加重试机制） ==========
startBtn.onclick = () => {
  const name = nameInput.value.trim();
  if (!name) return alert("请输入昵称");
  myName = name;
  loginBox.classList.add("hidden");
  gameBox.classList.remove("hidden");
  statusEl.textContent = "正在匹配对手...";
  startMatch(0);
};

// 匹配逻辑，最多重试3次
async function startMatch(retryCount) {
  if (retryCount > 3) {
    addSystemMessage("匹配失败，请刷新页面重试");
    return;
  }

  // 查询等待中的房间
  const { data: waitingRooms, error: queryError } = await sb
    .from("rooms")
    .select("id")
    .eq("status", "waiting")
    .limit(1);

  if (queryError) {
    console.error("查询房间失败：", queryError);
    setTimeout(() => startMatch(retryCount + 1), 500);
    return;
  }

  let roomId;
  if (waitingRooms.length > 0) {
    roomId = waitingRooms[0].id;
    const joinSuccess = await joinRoom(roomId);
    if (!joinSuccess) {
      // 加入失败，重试匹配下一个房间
      setTimeout(() => startMatch(retryCount + 1), 300);
      return;
    }
    // 加入成功，更新房间状态
    await sb.from("rooms").update({ status: "playing" }).eq("id", roomId);
  } else {
    roomId = await createRoom();
    if (!roomId) {
      setTimeout(() => startMatch(retryCount + 1), 500);
      return;
    }
  }

  currentRoomId = roomId;
  subscribeRoom(roomId);
  initRoomData();
  addSystemMessage("已进入房间，等待对手加入...");
}

// 创建新房间
async function createRoom() {
  const deck = [];
  for (let i = 1; i <= 20; i++) deck.push(i);
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }

  const { data: room, error: roomError } = await sb
    .from("rooms")
    .insert({ deck, status: "waiting", turn: myPlayerId })
    .select("id")
    .single();

  if (roomError) {
    console.error("创建房间失败：", roomError);
    return null;
  }

  const myHand = deck.splice(0, 3);
  const { error: playerError } = await sb.from("room_players").insert({
    room_id: room.id,
    player_id: myPlayerId,
    name: myName,
    hand: myHand
  });

  if (playerError) {
    console.error("加入房间失败：", playerError);
    return null;
  }

  await sb.from("rooms").update({ deck }).eq("id", room.id);
  return room.id;
}

// 加入房间（兼容重复加入）
async function joinRoom(roomId) {
  // 先检查是否已经在房间里
  const { data: existPlayer } = await sb
    .from("room_players")
    .select("*")
    .eq("room_id", roomId)
    .eq("player_id", myPlayerId)
    .maybeSingle();

  // 已经在房间里，直接返回成功
  if (existPlayer) return true;

  const { data: room, error: roomError } = await sb
    .from("rooms")
    .select("deck, turn, status")
    .eq("id", roomId)
    .single();

  if (roomError || room.status !== "waiting") {
    console.error("房间不可加入：", roomError || "房间状态已变更");
    return false;
  }

  const deck = room.deck;
  if (deck.length < 3) return false;

  const myHand = deck.splice(0, 3);
  const { error: joinError } = await sb.from("room_players").insert({
    room_id: roomId,
    player_id: myPlayerId,
    name: myName,
    hand: myHand
  });

  if (joinError) {
    console.error("加入房间失败：", joinError);
    return false;
  }

  await sb.from("rooms").update({ deck }).eq("id", roomId);
  return true;
}

// 订阅实时数据
function subscribeRoom(roomId) {
  realtimeChannel = sb.channel("room-" + roomId)
    .on("postgres_changes", {
      event: "*",
      schema: "public",
      table: "room_players",
      filter: `room_id=eq.${roomId}`
    }, (payload) => {
      const updatedPlayer = payload.new;
      const idx = currentPlayersData.findIndex(p => p.id === updatedPlayer.id);
      if (idx > -1) {
        currentPlayersData[idx] = updatedPlayer;
      } else {
        currentPlayersData.push(updatedPlayer);
      }
      renderGameUI();
    })
    .on("postgres_changes", {
      event: "*",
      schema: "public",
      table: "rooms",
      filter: `id=eq.${roomId}`
    }, (payload) => {
      currentRoomData = payload.new;
      renderGameUI();
    })
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

// 初始化房间数据
async function initRoomData() {
  if (!currentRoomId) return;

  const { data: room } = await sb
    .from("rooms")
    .select("*")
    .eq("id", currentRoomId)
    .single();

  const { data: players } = await sb
    .from("room_players")
    .select("*")
    .eq("room_id", currentRoomId);

  currentRoomData = room;
  currentPlayersData = players;
  renderGameUI();
}

// 纯本地渲染
function renderGameUI() {
  if (!currentRoomData || !currentPlayersData.length) return;

  const me = currentPlayersData.find(p => p.player_id === myPlayerId);
  const turnPlayer = currentPlayersData.find(p => p.player_id === currentRoomData.turn);
  const opponent = currentPlayersData.find(p => p.player_id !== myPlayerId);

  statusEl.textContent = opponent ? "对战中" : "等待对手加入";
  turnInfoEl.textContent = `当前回合：${turnPlayer ? turnPlayer.name : "等待中"}`;
  deckInfoEl.textContent = `牌库剩余：${currentRoomData.deck.length}`;

  handEl.innerHTML = "";
  if (me) {
    me.hand.forEach(card => {
      const btn = document.createElement("button");
      btn.className = "card";
      btn.textContent = card;
      btn.disabled = currentRoomData.turn !== myPlayerId;
      btn.onclick = () => playCard(card);
      handEl.appendChild(btn);
    });
  }

  if (currentRoomData.status === "playing" && opponent && !statusEl.dataset.started) {
    addSystemMessage("对手已加入，游戏开始！");
    statusEl.dataset.started = "1";
  }
}

// 抽牌（乐观更新）
drawBtn.onclick = async () => {
  if (!currentRoomId || currentRoomData.turn !== myPlayerId) {
    return addSystemMessage("还没轮到你");
  }
  if (currentRoomData.deck.length === 0) {
    return addSystemMessage("牌库已经没有牌了");
  }

  const newDeck = [...currentRoomData.deck];
  const card = newDeck.pop();
  currentRoomData.deck = newDeck;

  const me = currentPlayersData.find(p => p.player_id === myPlayerId);
  const newHand = [...me.hand, card];
  me.hand = newHand;

  renderGameUI();
  addSystemMessage("你抽了一张牌");

  await sb
    .from("room_players")
    .update({ hand: newHand })
    .eq("room_id", currentRoomId)
    .eq("player_id", myPlayerId);

  await sb.from("rooms").update({ deck: newDeck }).eq("id", currentRoomId);
};

// 出牌（乐观更新）
async function playCard(card) {
  if (currentRoomData.turn !== myPlayerId) return;

  const me = currentPlayersData.find(p => p.player_id === myPlayerId);
  const newHand = me.hand.filter(c => c !== card);
  me.hand = newHand;

  const opponent = currentPlayersData.find(p => p.player_id !== myPlayerId);
  if (opponent) {
    currentRoomData.turn = opponent.player_id;
  }

  renderGameUI();
  addSystemMessage(`你打出了 ${card}，轮到对手`);

  await sb
    .from("room_players")
    .update({ hand: newHand })
    .eq("room_id", currentRoomId)
    .eq("player_id", myPlayerId);

  if (opponent) {
    await sb
      .from("rooms")
      .update({ turn: opponent.player_id })
      .eq("id", currentRoomId);
  }
}

// 聊天逻辑
sendChatBtn.onclick = sendChat;
chatInput.addEventListener("keydown", e => {
  if (e.key === "Enter") sendChat();
});

async function sendChat() {
  const message = chatInput.value.trim();
  if (!message || !currentRoomId) return;
  await sb.from("chats").insert({
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

window.addEventListener("beforeunload", () => {
  if (realtimeChannel) sb.removeChannel(realtimeChannel);
});
