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

// ========== 页面加载完成后再执行所有DOM操作（修复按钮点击没反应核心） ==========
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

    // 结束回合按钮状态：只有自己回合且对手存在才能点
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

  // ========== 自动抽牌（加固版，避免漏抽） ==========
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

    // 后台同步数据库
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
      addLocalTip("抽牌同步失败，请刷新页面");
    }
  }

  // ========== 出牌逻辑 ==========
  async function playCard(card) {
    if (currentRoomData.turn !== myPlayerId) return;

    const me = currentPlayersData.find(p => p.player_id === myPlayerId);
    const newHand = me.hand.filter(c => c !== card);
    me.hand = newHand;
    renderGameUI();

    try {
      await sb.from("room_players")
        .update({ hand: newHand })
        .eq("room_id", currentRoomId)
        .eq("player_id", myPlayerId);
      sendSystemMessage(`${myName} 打出了 ${card}`);
    } catch (e) {
      console.error("出牌同步失败：", e);
      addLocalTip("出牌同步失败，请重试");
    }
  }

  // ========== 结束回合（加固版，有明确反馈） ==========
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

    // 后台同步
    try {
      await sb.from("rooms")
        .update({ turn: opponent.player_id })
        .eq("id", currentRoomId);
      sendSystemMessage(`${myName} 结束了回合`);
    } catch (e) {
      console.error("结束回合失败：", e);
      addLocalTip("结束回合失败，请重试");
      // 失败回滚本地状态
      currentRoomData.turn = myPlayerId;
      renderGameUI();
    }
  }

  // ========== 订阅实时数据（加固版，确认订阅成功） ==========
  function subscribeRoom(roomId) {
    // 先清理旧订阅
    if (realtimeChannel) {
      sb.removeChannel(realtimeChannel);
    }

    realtimeChannel = sb.channel("room-" + roomId);

    // 监听玩家数据变化
    realtimeChannel.on("postgres_changes", {
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
    });

    // 监听房间状态变化（修复抽牌核心：加固回合切换判定）
    realtimeChannel.on("postgres_changes", {
      event: "*",
      schema: "public",
      table: "rooms",
      filter: `id=eq.${roomId}`
    }, (payload) => {
      const newRoomData = payload.new;
      currentRoomData = newRoomData;

      // 回合切换判定：严格对比新旧回合，且新回合是自己才抽牌
      if (newRoomData.turn !== lastTurn && newRoomData.status === "playing") {
        const isMyNewTurn = newRoomData.turn === myPlayerId;
        lastTurn = newRoomData.turn;
        hasDrawnThisTurn = false;

        // 只有轮到自己且不是开局先手，才自动抽牌
        if (isMyNewTurn) {
          // 延迟执行，确保玩家数据已同步
          setTimeout(() => {
            autoDrawCard();
          }, 100);
        }
      }

      renderGameUI();
    });

    // 监听聊天+系统消息
    realtimeChannel.on("postgres_changes", {
      event: "INSERT",
      schema: "public",
      table: "chats",
      filter: `room_id=eq.${roomId}`
    }, (payload) => {
      const msg = payload.new;
      addChatMessage(msg.name, msg.message);
    });

    // 订阅状态回调，确认是否成功
    realtimeChannel.subscribe((status) => {
      console.log("实时订阅状态：", status);
      if (status === "SUBSCRIBED") {
        addLocalTip("实时连接已建立");
      } else if (status === "CLOSED") {
        addLocalTip("实时连接断开，正在重连...");
      }
    });
  }

  // ========== 初始化房间全量数据 ==========
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
    // 初始化：如果当前就是自己回合，标记为已抽牌（开局初始手牌已发）
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
      .limit(100);

    if (chats && chats.length > 0) {
      chatBox.innerHTML = "";
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
    const [{ data: room }, { data: players }] = await Promise.all([
      sb.from("rooms").select("deck, turn, status").eq("id", roomId).single(),
      sb.from("room_players").select("player_id").eq("room_id", roomId)
    ]);

    if (!room || room.status !== "waiting" || players.length >= 2) {
      return false;
    }

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

  // ========== 匹配逻辑 ==========
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
        await sb.from("rooms").update({ status: "playing" }).eq("id", roomId);
        currentRoomId = roomId;
        initRoomAndSubscribe();
        sendSystemMessage("游戏开始！");
        return;
      }
    }

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
