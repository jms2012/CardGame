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

// ========== 页面加载完成后执行 ==========
window.addEventListener("DOMContentLoaded", () => {
  // DOM元素统一获取
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

  // ========== 【核心修复1：彻底清理旧状态，杜绝数据混杂】 ==========
  function resetAllState() {
    // 清理旧订阅
    if (realtimeChannel) {
      sb.removeChannel(realtimeChannel);
      realtimeChannel = null;
    }
    // 重置所有全局状态
    currentRoomId = null;
    currentRoomData = null;
    currentPlayersData = [];
    lastTurn = "";
    hasDrawnThisTurn = false;
    // 清空界面
    chatBox.innerHTML = "";
    handEl.innerHTML = "";
  }

  // ========== 工具函数 ==========
  async function sendSystemMessage(content) {
    if (!currentRoomId) return;
    await sb.from("chats").insert({
      room_id: currentRoomId,
      name: "系统",
      message: content
    });
  }

  function addLocalTip(msg) {
    const div = document.createElement("div");
    div.className = "system-message";
    div.textContent = `[提示] ${msg}`;
    chatBox.appendChild(div);
    chatBox.scrollTop = chatBox.scrollHeight;
  }

  function addChatMessage(name, message) {
    const div = document.createElement("div");
    div.className = name === "系统" ? "system-message" : "chat-line";
    div.textContent = name === "系统" ? `[系统] ${message}` : `${name}: ${message}`;
    chatBox.appendChild(div);
    chatBox.scrollTop = chatBox.scrollHeight;
  }

  // ========== 纯本地渲染界面 ==========
  function renderGameUI() {
    if (!currentRoomData || !currentPlayersData.length) return;

    const me = currentPlayersData.find(p => p.player_id === myPlayerId);
    const turnPlayer = currentPlayersData.find(p => p.player_id === currentRoomData.turn);
    const opponent = currentPlayersData.find(p => p.player_id !== myPlayerId);

    statusEl.textContent = opponent ? "对战中" : "等待对手加入";
    turnInfoEl.textContent = `当前回合：${turnPlayer ? turnPlayer.name : "等待中"}`;
    deckInfoEl.textContent = `牌库剩余：${currentRoomData.deck.length}`;

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

    if (currentRoomData.status === "playing" && opponent && !statusEl.dataset.started) {
      statusEl.dataset.started = "1";
    }
  }

  // ========== 自动抽牌 ==========
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

    // 后台同步数据库（双条件校验：房间ID+玩家ID，防止串改）
    try {
      await Promise.all([
        sb.from("room_players")
          .update({ hand: newHand })
          .eq("room_id", currentRoomId)
          .eq("player_id", myPlayerId),
        sb.from("rooms").update({ deck: newDeck }).eq("id", currentRoomId)
      ]);
      sendSystemMessage(`${myName} 抽到了一张牌`);
    } catch (e) {
      console.error("抽牌同步失败：", e);
      addLocalTip("抽牌同步失败，正在刷新数据");
      initRoomData(); // 失败自动拉取最新数据修正
    }
  }

  // ========== 出牌逻辑 ==========
  async function playCard(card) {
    if (currentRoomData.turn !== myPlayerId) return;

    const me = currentPlayersData.find(p => p.player_id === myPlayerId);
    const newHand = me.hand.filter(c => c !== card);
    me.hand = newHand;
    renderGameUI();

    // 双条件校验更新，防止跨房间修改
    try {
      await sb.from("room_players")
        .update({ hand: newHand })
        .eq("room_id", currentRoomId)
        .eq("player_id", myPlayerId);
      sendSystemMessage(`${myName} 打出了 ${card}`);
    } catch (e) {
      console.error("出牌同步失败：", e);
      addLocalTip("出牌同步失败，正在刷新数据");
      initRoomData();
    }
  }

  // ========== 结束回合 ==========
  async function endTurn() {
    if (currentRoomData.turn !== myPlayerId) {
      addLocalTip("还没轮到你，无法结束回合");
      return;
    }

    const opponent = currentPlayersData.find(p => p.player_id !== myPlayerId);
    if (!opponent) {
      addLocalTip("对手未加入，无法结束回合");
      return;
    }

    // 乐观更新本地回合
    currentRoomData.turn = opponent.player_id;
    renderGameUI();
    addLocalTip("已结束回合，等待对手操作");

    // 按房间ID精准更新
    try {
      await sb.from("rooms")
        .update({ turn: opponent.player_id })
        .eq("id", currentRoomId);
      sendSystemMessage(`${myName} 结束了回合`);
    } catch (e) {
      console.error("结束回合失败：", e);
      addLocalTip("结束回合失败，请重试");
      currentRoomData.turn = myPlayerId;
      renderGameUI();
    }
  }

  // ========== 【核心修复2：实时订阅严格隔离，防串数据】 ==========
  function subscribeRoom(roomId) {
    // 先彻底清理旧订阅，防止多频道并存导致数据混杂
    if (realtimeChannel) {
      sb.removeChannel(realtimeChannel);
      realtimeChannel = null;
    }

    realtimeChannel = sb.channel("room-" + roomId);

    // 监听玩家数据变化 + 房间ID二次校验
    realtimeChannel.on("postgres_changes", {
      event: "*",
      schema: "public",
      table: "room_players",
      filter: `room_id=eq.${roomId}`
    }, (payload) => {
      // 【关键校验】数据不属于当前房间直接丢弃
      if (payload.new.room_id !== currentRoomId) return;

      const updatedPlayer = payload.new;
      const idx = currentPlayersData.findIndex(p => p.player_id === updatedPlayer.player_id);
      if (idx > -1) {
        currentPlayersData[idx] = updatedPlayer;
      } else {
        currentPlayersData.push(updatedPlayer);
      }
      renderGameUI();
    });

    // 监听房间状态变化 + 房间ID二次校验
    realtimeChannel.on("postgres_changes", {
      event: "*",
      schema: "public",
      table: "rooms",
      filter: `id=eq.${roomId}`
    }, (payload) => {
      // 【关键校验】数据不属于当前房间直接丢弃
      if (payload.new.id !== currentRoomId) return;

      const newRoomData = payload.new;
      currentRoomData = newRoomData;

      // 回合切换判定
      if (newRoomData.turn !== lastTurn && newRoomData.status === "playing") {
        const isMyNewTurn = newRoomData.turn === myPlayerId;
        lastTurn = newRoomData.turn;
        hasDrawnThisTurn = false;

        if (isMyNewTurn) {
          setTimeout(() => {
            autoDrawCard();
          }, 100);
        }
      }

      renderGameUI();
    });

    // 监听聊天+系统消息 + 房间ID二次校验
    realtimeChannel.on("postgres_changes", {
      event: "INSERT",
      schema: "public",
      table: "chats",
      filter: `room_id=eq.${roomId}`
    }, (payload) => {
      if (payload.new.room_id !== currentRoomId) return;
      const msg = payload.new;
      addChatMessage(msg.name, msg.message);
    });

    // 订阅状态回调
    realtimeChannel.subscribe((status) => {
      console.log("实时订阅状态：", status);
      if (status === "SUBSCRIBED") {
        addLocalTip("实时连接已建立");
      } else if (status === "CLOSED") {
        addLocalTip("实时连接断开，正在重连...");
      }
    });
  }

  // ========== 初始化房间全量数据（只拉当前房间） ==========
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

  // 加载当前房间历史聊天
  async function loadHistoryChat() {
    if (!currentRoomId) return;
    const { data: chats } = await sb
      .from("chats")
      .select("name, message, created_at")
      .eq("room_id", currentRoomId)
      .order("created_at", { ascending: true })
      .limit(100);

    chatBox.innerHTML = "";
    if (chats && chats.length > 0) {
      chats.forEach(msg => addChatMessage(msg.name, msg.message));
    }
  }

  async function initRoomAndSubscribe() {
    await initRoomData();
    subscribeRoom(currentRoomId);
    loadHistoryChat();
  }

  // ========== 创建房间 ==========
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

  // ========== 加入房间 ==========
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

  // ========== 【核心修复3：匹配前先查已有房间，防止重复开房】 ==========
  async function startMatch() {
    // 第一步：先彻底重置所有旧状态，防止上一局数据残留
    resetAllState();

    // 第二步：先查自己是否已经在某个房间里，有就直接进入，不重复创建
    const { data: myRooms } = await sb
      .from("room_players")
      .select("room_id, rooms!inner(status)")
      .eq("player_id", myPlayerId)
      .in("rooms.status", ["waiting", "playing"]);

    if (myRooms && myRooms.length > 0) {
      const existRoomId = myRooms[0].room_id;
      currentRoomId = existRoomId;
      initRoomAndSubscribe();
      addLocalTip("已回到之前的房间");
      return;
    }

    // 第三步：正常匹配逻辑
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
        await sb.from("rooms").update({ status: "playing" }).eq("id", roomId);
        currentRoomId = roomId;
        initRoomAndSubscribe();
        sendSystemMessage("游戏开始！");
        return;
      }
    }

    // 无可用房间则创建新房间
    createAndEnterRoom();
  }

  // ========== 聊天逻辑 ==========
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

  // ========== 事件绑定 ==========
  startBtn.onclick = () => {
    const name = nameInput.value.trim();
    if (!name) return alert("请输入昵称");
    myName = name;
    loginBox.classList.add("hidden");
    gameBox.classList.remove("hidden");
    statusEl.textContent = "正在匹配对手...";
    startMatch();
  };

  endTurnBtn.onclick = endTurn;

  sendChatBtn.onclick = sendChat;
  chatInput.addEventListener("keydown", e => {
    if (e.key === "Enter") sendChat();
  });

  // 页面关闭清理订阅
  window.addEventListener("beforeunload", () => {
    if (realtimeChannel) sb.removeChannel(realtimeChannel);
  });
});
