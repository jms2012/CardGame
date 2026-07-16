// ===================== 配置项：替换成你自己的 =====================
const SUPABASE_URL = "https://card-game.474804665.workers.dev";
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
let lastTurn = ""; // 记录上一回合，用于检测回合切换
let hasDrawnThisTurn = false; // 本回合是否已抽牌，防止重复抽

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

// 隐藏手动抽牌按钮（已改为自动抽牌）
if (drawBtn) drawBtn.style.display = "none";

// ========== 入口：开始匹配 ==========
startBtn.onclick = () => {
  const name = nameInput.value.trim();
  if (!name) return alert("请输入昵称");
  myName = name;
  loginBox.classList.add("hidden");
  gameBox.classList.remove("hidden");
  statusEl.textContent = "正在匹配对手...";
  startMatch(0);
};

// 匹配逻辑，带重试机制
async function startMatch(retryCount) {
  if (retryCount > 3) {
    addSystemMessage("匹配失败，请刷新页面重试");
    return;
  }

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
      setTimeout(() => startMatch(retryCount + 1), 300);
      return;
    }
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
  // 先检查是否已在房间内
  const { data: existPlayer } = await sb
    .from("room_players")
    .select("*")
    .eq("room_id", roomId)
    .eq("player_id", myPlayerId)
    .maybeSingle();

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

// 订阅实时数据（修复同步核心：改用player_id匹配玩家）
function subscribeRoom(roomId) {
  realtimeChannel = sb.channel("room-" + roomId)
    // 监听玩家数据变化（手牌、加入）
    .on("postgres_changes", {
      event: "*",
      schema: "public",
      table: "room_players",
      filter: `room_id=eq.${roomId}`
    }, (payload) => {
      const updatedPlayer = payload.new;
      // 改用player_id匹配，彻底解决同步错位
      const idx = currentPlayersData.findIndex(p => p.player_id === updatedPlayer.player_id);
      if (idx > -1) {
        currentPlayersData[idx] = updatedPlayer;
      } else {
        currentPlayersData.push(updatedPlayer);
      }
      renderGameUI();
    })
    // 监听房间状态变化（回合、牌库、状态）
    .on("postgres_changes", {
      event: "*",
      schema: "public",
      table: "rooms",
      filter: `id=eq.${roomId}`
    }, (payload) => {
      const newRoomData = payload.new;
      currentRoomData = newRoomData;

      // 检测回合切换：新回合是自己 → 自动抽牌
      if (newRoomData.turn !== lastTurn && newRoomData.status === "playing") {
        lastTurn = newRoomData.turn;
        hasDrawnThisTurn = false; // 新回合重置抽牌标记
        if (newRoomData.turn === myPlayerId) {
          autoDrawCard(); // 轮到自己，自动抽牌
        }
      }

      renderGameUI();
    })
    // 监听聊天消息
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

// 初始化房间全量数据（仅进入时调用一次）
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
  lastTurn = room.turn; // 初始化回合标记
  hasDrawnThisTurn = false;
  renderGameUI();
}

// 自动抽牌（回合开始触发）
async function autoDrawCard() {
  if (!currentRoomId || !currentRoomData) return;
  if (hasDrawnThisTurn) return; // 防止重复抽牌
  if (currentRoomData.deck.length === 0) {
    addSystemMessage("牌库已空，无法抽牌");
    return;
  }

  hasDrawnThisTurn = true;

  // 乐观更新：本地立刻刷新界面
  const newDeck = [...currentRoomData.deck];
  const card = newDeck.pop();
  currentRoomData.deck = newDeck;

  const me = currentPlayersData.find(p => p.player_id === myPlayerId);
  const newHand = [...me.hand, card];
  me.hand = newHand;

  renderGameUI();
  addSystemMessage(`回合开始，你抽到了 ${card}`);

  // 后台静默同步数据库
  await sb
    .from("room_players")
    .update({ hand: newHand })
    .eq("room_id", currentRoomId)
    .eq("player_id", myPlayerId);

  await sb.from("rooms").update({ deck: newDeck }).eq("id", currentRoomId);
}

// 纯本地渲染，毫秒级响应
function renderGameUI() {
  if (!currentRoomData || !currentPlayersData.length) return;

  const me = currentPlayersData.find(p => p.player_id === myPlayerId);
  const turnPlayer = currentPlayersData.find(p => p.player_id === currentRoomData.turn);
  const opponent = currentPlayersData.find(p => p.player_id !== myPlayerId);

  statusEl.textContent = opponent ? "对战中" : "等待对手加入";
  turnInfoEl.textContent = `当前回合：${turnPlayer ? turnPlayer.name : "等待中"}`;
  deckInfoEl.textContent = `牌库剩余：${currentRoomData.deck.length}`;

  // 渲染手牌
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

  // 游戏开始提示
  if (currentRoomData.status === "playing" && opponent && !statusEl.dataset.started) {
    addSystemMessage("对手已加入，游戏开始！");
    statusEl.dataset.started = "1";
  }
}

// 出牌（乐观更新 + 切换回合）
async function playCard(card) {
  if (currentRoomData.turn !== myPlayerId) return;

  // 本地立刻更新界面
  const me = currentPlayersData.find(p => p.player_id === myPlayerId);
  const newHand = me.hand.filter(c => c !== card);
  me.hand = newHand;

  // 切换回合给对手
  const opponent = currentPlayersData.find(p => p.player_id !== myPlayerId);
  if (opponent) {
    currentRoomData.turn = opponent.player_id;
  }

  renderGameUI();
  addSystemMessage(`你打出了 ${card}，轮到对手`);

  // 后台同步数据库
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

// ========== 聊天逻辑 ==========
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
