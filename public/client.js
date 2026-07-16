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
const endTurnBtn = document.getElementById("endTurnBtn");
const chatBox = document.getElementById("chatBox");
const chatInput = document.getElementById("chatInput");
const sendChatBtn = document.getElementById("sendChatBtn");

// ========== 工具函数：发送同步系统消息（存入数据库，双方可见） ==========
async function sendSystemMessage(content) {
  if (!currentRoomId) return;
  await sb.from("chats").insert({
    room_id: currentRoomId,
    name: "系统",
    message: content
  });
}

// 本地临时提示（仅本地显示，不同步）
function addLocalTip(msg) {
  const div = document.createElement("div");
  div.className = "system-message";
  div.textContent = `[提示] ${msg}`;
  chatBox.appendChild(div);
  chatBox.scrollTop = chatBox.scrollHeight;
}

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

// 匹配逻辑：加入失败直接创建新房间，避免死循环
async function startMatch() {
  const { data: waitingRooms, error: queryError } = await sb
    .from("rooms")
    .select("id")
    .eq("status", "waiting")
    .order("created_at", { ascending: true })
    .limit(1);

  if (queryError) {
    console.error("查询房间失败：", queryError);
    addLocalTip("匹配出错，正在创建新房间...");
    createAndEnterRoom();
    return;
  }

  if (waitingRooms.length > 0) {
    const roomId = waitingRooms[0].id;
    const joinSuccess = await joinRoom(roomId);
    if (joinSuccess) {
      // 加入成功，开启游戏
      await sb.from("rooms").update({ status: "playing" }).eq("id", roomId);
      currentRoomId = roomId;
      initRoomAndSubscribe();
      sendSystemMessage("游戏开始！");
      return;
    }
  }

  // 无可用房间，创建新房间
  createAndEnterRoom();
}

// 创建房间并进入
async function createAndEnterRoom() {
  const roomId = await createRoom();
  if (!roomId) {
    addLocalTip("创建房间失败，请刷新页面重试");
    return;
  }
  currentRoomId = roomId;
  initRoomAndSubscribe();
  sendSystemMessage(`${myName} 创建了房间，等待对手加入...`);
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

// 加入房间
async function joinRoom(roomId) {
  // 先校验房间状态和人数
  const [{ data: room }, { data: players }] = await Promise.all([
    sb.from("rooms").select("deck, turn, status").eq("id", roomId).single(),
    sb.from("room_players").select("player_id").eq("room_id", roomId)
  ]);

  if (!room || room.status !== "waiting" || players.length >= 2) {
    return false;
  }

  // 自己已在房间内直接返回成功
  if (players.some(p => p.player_id === myPlayerId)) {
    return true;
  }

  // 发初始手牌并加入
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
  sendSystemMessage(`${myName} 加入了房间`);
  return true;
}

// 初始化房间数据+订阅实时推送
async function initRoomAndSubscribe() {
  await initRoomData();
  subscribeRoom(currentRoomId);
  loadHistoryChat();
}

// 订阅实时数据（消息、房间、玩家全同步）
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

      // 检测回合切换：新回合是自己则自动抽牌
      if (newRoomData.turn !== lastTurn && newRoomData.status === "playing") {
        const wasWaiting = lastTurn === "";
        lastTurn = newRoomData.turn;
        hasDrawnThisTurn = false;
        
        // 游戏刚开局且自己是先手，不抽牌（初始已发3张）
        if (wasWaiting && newRoomData.turn === myPlayerId) {
          hasDrawnThisTurn = true;
        } else if (newRoomData.turn === myPlayerId) {
          autoDrawCard();
        }
      }

      renderGameUI();
    })
    // 监听聊天+系统消息（统一实时渲染，保证两边完全同步）
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

// 加载历史聊天+系统消息
async function loadHistoryChat() {
  if (!currentRoomId) return;
  const { data: chats } = await sb
    .from("chats")
    .select("name, message, created_at")
    .eq("room_id", currentRoomId)
    .order("created_at", { ascending: true })
    .limit(100);

  if (chats && chats.length > 0) {
    chatBox.innerHTML = "";
    chats.forEach(msg => addChatMessage(msg.name, msg.message));
  }
}

// 自动抽牌（回合开始触发）
async function autoDrawCard() {
  if (!currentRoomId || !currentRoomData) return;
  if (hasDrawnThisTurn) return;
  if (currentRoomData.deck.length === 0) {
    sendSystemMessage("牌库已空，本回合无法抽牌");
    hasDrawnThisTurn = true;
    return;
  }

  hasDrawnThisTurn = true;

  // 乐观更新本地状态
  const newDeck = [...currentRoomData.deck];
  const card = newDeck.pop();
  currentRoomData.deck = newDeck;

  const me = currentPlayersData.find(p => p.player_id === myPlayerId);
  const newHand = [...me.hand, card];
  me.hand = newHand;

  renderGameUI();

  // 后台同步数据库 + 发送同步系统消息
  await Promise.all([
    sb.from("room_players")
      .update({ hand: newHand })
      .eq("room_id", currentRoomId)
      .eq("player_id", myPlayerId),
    sb.from("rooms").update({ deck: newDeck }).eq("id", currentRoomId)
  ]);

  sendSystemMessage(`${myName} 抽到了一张牌`);
}

// ========== 出牌：单回合可出多张，不自动结束回合 ==========
async function playCard(card) {
  if (currentRoomData.turn !== myPlayerId) return;

  // 乐观更新本地手牌，界面秒响应
  const me = currentPlayersData.find(p => p.player_id === myPlayerId);
  const newHand = me.hand.filter(c => c !== card);
  me.hand = newHand;
  renderGameUI();

  // 后台同步数据库 + 发送同步消息
  await sb.from("room_players")
    .update({ hand: newHand })
    .eq("room_id", currentRoomId)
    .eq("player_id", myPlayerId);

  sendSystemMessage(`${myName} 打出了 ${card}`);
}

// ========== 结束回合：点击按钮后切换回合 ==========
endTurnBtn.onclick = endTurn;

async function endTurn() {
  if (currentRoomData.turn !== myPlayerId) return;

  const opponent = currentPlayersData.find(p => p.player_id !== myPlayerId);
  if (!opponent) {
    addLocalTip("对手未加入，无法结束回合");
    return;
  }

  // 乐观更新本地回合
  currentRoomData.turn = opponent.player_id;
  renderGameUI();

  // 后台同步数据库 + 发送消息
  await sb.from("rooms")
    .update({ turn: opponent.player_id })
    .eq("id", currentRoomId);

  sendSystemMessage(`${myName} 结束了回合`);
}

// 纯本地渲染界面
function renderGameUI() {
  if (!currentRoomData || !currentPlayersData.length) return;

  const me = currentPlayersData.find(p => p.player_id === myPlayerId);
  const turnPlayer = currentPlayersData.find(p => p.player_id === currentRoomData.turn);
  const opponent = currentPlayersData.find(p => p.player_id !== myPlayerId);

  statusEl.textContent = opponent ? "对战中" : "等待对手加入";
  turnInfoEl.textContent = `当前回合：${turnPlayer ? turnPlayer.name : "等待中"}`;
  deckInfoEl.textContent = `牌库剩余：${currentRoomData.deck.length}`;

  // 结束回合按钮状态控制
  endTurnBtn.disabled = currentRoomData.turn !== myPlayerId || !opponent;

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

  // 游戏开始提示（由系统消息统一显示，此处仅做标记）
  if (currentRoomData.status === "playing" && opponent && !statusEl.dataset.started) {
    statusEl.dataset.started = "1";
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

  const { error } = await sb.from("chats").insert({
    room_id: currentRoomId,
    name: myName,
    message
  });

  if (error) {
    console.error("发送消息失败：", error);
    addLocalTip("消息发送失败，请重试");
    return;
  }
  chatInput.value = "";
}

function addChatMessage(name, message) {
  const div = document.createElement("div");
  div.className = name === "系统" ? "system-message" : "chat-line";
  div.textContent = name === "系统" ? `[系统] ${message}` : `${name}: ${message}`;
  chatBox.appendChild(div);
  chatBox.scrollTop = chatBox.scrollHeight;
}

// 页面关闭时清理订阅
window.addEventListener("beforeunload", () => {
  if (realtimeChannel) sb.removeChannel(realtimeChannel);
});
