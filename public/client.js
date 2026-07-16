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
let lastTurn = "";
let hasDrawnThisTurn = false;

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

// 隐藏手动抽牌按钮
if (drawBtn) drawBtn.style.display = "none";

// ========== 入口：开始匹配 ==========
startBtn.onclick = () => {
  const name = nameInput.value.trim();
  if (!name) return alert("请输入昵称");
  myName = name;
  loginBox.classList.add("hidden");
  gameBox.classList.remove("hidden");
  statusEl.textContent = "正在匹配对手...";
  startMatch();
};

// 【修复】匹配逻辑：加入失败直接创建新房间，避免死循环
async function startMatch() {
  // 先查询等待中的房间
  const { data: waitingRooms, error: queryError } = await sb
    .from("rooms")
    .select("id")
    .eq("status", "waiting")
    .order("created_at", { ascending: true })
    .limit(1);

  if (queryError) {
    console.error("查询房间失败：", queryError);
    addSystemMessage("匹配出错，正在创建新房间...");
    createAndEnterRoom();
    return;
  }

  // 有等待房间，尝试加入
  if (waitingRooms.length > 0) {
    const roomId = waitingRooms[0].id;
    const joinSuccess = await joinRoom(roomId);
    if (joinSuccess) {
      // 加入成功，更新房间状态为游戏中
      await sb.from("rooms").update({ status: "playing" }).eq("id", roomId);
      currentRoomId = roomId;
      initRoomAndSubscribe();
      addSystemMessage("已加入房间，游戏即将开始...");
      return;
    }
  }

  // 没有等待房间 / 加入失败，直接创建新房间
  createAndEnterRoom();
}

// 创建房间并进入
async function createAndEnterRoom() {
  const roomId = await createRoom();
  if (!roomId) {
    addSystemMessage("创建房间失败，请刷新页面重试");
    return;
  }
  currentRoomId = roomId;
  initRoomAndSubscribe();
  addSystemMessage("已创建房间，等待对手加入...");
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

// 【修复】加入房间：先校验人数和状态，避免满员/状态异常
async function joinRoom(roomId) {
  // 1. 先查房间当前状态和玩家数
  const [{ data: room }, { data: players }] = await Promise.all([
    sb.from("rooms").select("deck, turn, status").eq("id", roomId).single(),
    sb.from("room_players").select("player_id").eq("room_id", roomId)
  ]);

  if (!room || room.status !== "waiting" || players.length >= 2) {
    return false;
  }

  // 2. 检查自己是否已经在房间里
  if (players.some(p => p.player_id === myPlayerId)) {
    return true;
  }

  // 3. 发初始手牌并加入
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

  // 4. 更新剩余牌库
  await sb.from("rooms").update({ deck }).eq("id", roomId);
  return true;
}

// 初始化房间数据+订阅实时推送
async function initRoomAndSubscribe() {
  await initRoomData();
  subscribeRoom(currentRoomId);
  loadHistoryChat(); // 加载历史聊天记录
}

// 【修复】订阅实时数据：修复玩家匹配、聊天监听
function subscribeRoom(roomId) {
  realtimeChannel = sb.channel("room-" + roomId)
    // 监听玩家数据变化
    .on("postgres_changes", {
      event: "*",
      schema: "public",
      table: "room_players",
      filter: `room_id=eq.${roomId}`
    }, (payload) => {
      const updatedPlayer = payload.new;
      const idx = currentPlayersData.findIndex(p => p.player_id === updatedPlayer.player_id);
      if (idx > -1) {
        currentPlayersData[idx] = updatedPlayer;
      } else {
        currentPlayersData.push(updatedPlayer);
      }
      renderGameUI();
    })
    // 监听房间状态变化
    .on("postgres_changes", {
      event: "*",
      schema: "public",
      table: "rooms",
      filter: `id=eq.${roomId}`
    }, (payload) => {
      const newRoomData = payload.new;
      currentRoomData = newRoomData;

      // 回合切换检测：新回合是自己则自动抽牌
      if (newRoomData.turn !== lastTurn && newRoomData.status === "playing") {
        const wasWaiting = lastTurn === "";
        lastTurn = newRoomData.turn;
        hasDrawnThisTurn = false;
        
        // 游戏刚开局、且自己是先手，不抽牌
        if (wasWaiting && newRoomData.turn === myPlayerId) {
          hasDrawnThisTurn = true;
        } else if (newRoomData.turn === myPlayerId) {
          autoDrawCard();
        }
      }

      renderGameUI();
    })
    // 【修复】监听聊天新消息
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

// 初始化房间全量数据
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
  lastTurn = room.turn;
  hasDrawnThisTurn = room.status === "playing" && room.turn === myPlayerId;
  renderGameUI();
}

// 加载历史聊天记录
async function loadHistoryChat() {
  if (!currentRoomId) return;
  const { data: chats } = await sb
    .from("chats")
    .select("name, message, created_at")
    .eq("room_id", currentRoomId)
    .order("created_at", { ascending: true })
    .limit(50);

  if (chats && chats.length > 0) {
    chatBox.innerHTML = "";
    chats.forEach(msg => addChatMessage(msg.name, msg.message));
  }
}

// 自动抽牌
async function autoDrawCard() {
  if (!currentRoomId || !currentRoomData) return;
  if (hasDrawnThisTurn) return;
  if (currentRoomData.deck.length === 0) {
    addSystemMessage("牌库已空，无法抽牌");
    return;
  }

  hasDrawnThisTurn = true;

  // 乐观更新
  const newDeck = [...currentRoomData.deck];
  const card = newDeck.pop();
  currentRoomData.deck = newDeck;

  const me = currentPlayersData.find(p => p.player_id === myPlayerId);
  const newHand = [...me.hand, card];
  me.hand = newHand;

  renderGameUI();
  addSystemMessage(`回合开始，你抽到了 ${card}`);

  // 后台同步
  await sb
    .from("room_players")
    .update({ hand: newHand })
    .eq("room_id", currentRoomId)
    .eq("player_id", myPlayerId);

  await sb.from("rooms").update({ deck: newDeck }).eq("id", currentRoomId);
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

// 出牌
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

// ========== 【修复】聊天逻辑：增加错误提示 ==========
sendChatBtn.onclick = sendChat;
chatInput.addEventListener("keydown", e => {
  if (e.key === "Enter") sendChat();
});

async function sendChat() {
  const message = chatInput.value.trim();
  if (!message || !currentRoomId) return;

  const { error } = await sb.from("chats").insert({
    room_id: currentRoomId,
    name: myName,
    message
  });

  if (error) {
    console.error("发送消息失败：", error);
    addSystemMessage("消息发送失败，请重试");
    return;
  }
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

