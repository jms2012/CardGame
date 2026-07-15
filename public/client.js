// ===== 部署完 Worker 后，替换成你的 Cloudflare Worker 地址 =====
const SERVER_URL = "https://你的worker名称.workers.dev";

const socket = io(SERVER_URL, {
  transports: ["websocket", "polling"],
  upgrade: true,
  reconnection: true, // 开启自动重连
  reconnectionDelay: 2000,
  reconnectionAttempts: 10
});

let currentRoomId = null;
let myName = "";

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

startBtn.onclick = () => {
  const name = nameInput.value.trim();
  if (!name) return alert("请输入昵称");
  myName = name;
  socket.emit("set-name", name);
  loginBox.classList.add("hidden");
  gameBox.classList.remove("hidden");
  statusEl.textContent = "正在匹配中...";
};

socket.on("connect", () => {
  addSystemMessage("已连接到服务器");
  if (statusEl) statusEl.textContent = "已连接";
});

socket.on("disconnect", () => {
  addSystemMessage("连接断开，正在自动重连...");
  if (statusEl) statusEl.textContent = "连接断开，重连中";
});

socket.on("reconnect", () => {
  addSystemMessage("重连成功！");
  if (statusEl) statusEl.textContent = "已重连";
});

socket.on("system-message", (msg) => {
  addSystemMessage(msg);
});

socket.on("game-start", (data) => {
  currentRoomId = data.roomId;
  renderGame(data);
  addSystemMessage("游戏开始！");
});

socket.on("game-update", (data) => {
  renderGame(data);
  if (data.message) addSystemMessage(data.message);
});

socket.on("chat", ({ name, message }) => {
  const div = document.createElement("div");
  div.className = "chat-line";
  div.textContent = `${name}: ${message}`;
  chatBox.appendChild(div);
  chatBox.scrollTop = chatBox.scrollHeight;
});

drawBtn.onclick = () => {
  if (!currentRoomId) return;
  socket.emit("draw-card", currentRoomId);
};

sendChatBtn.onclick = sendChat;
chatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") sendChat();
});

function sendChat() {
  const message = chatInput.value.trim();
  if (!message || !currentRoomId) return;
  socket.emit("chat", { roomId: currentRoomId, message });
  chatInput.value = "";
}

function renderGame(data) {
  const me = data.players.find((p) => p.name === myName);
  const turnPlayer = data.players.find((p) => p.id === data.turn);
  statusEl.textContent = `房间已连接`;
  turnInfoEl.textContent = `当前回合：${turnPlayer ? turnPlayer.name : "未知"}`;
  deckInfoEl.textContent = `牌库剩余：${data.deckCount}`;
  handEl.innerHTML = "";
  if (me) {
    me.hand.forEach((card) => {
      const btn = document.createElement("button");
      btn.className = "card";
      btn.textContent = card;
      btn.onclick = () => {
        socket.emit("play-card", { roomId: currentRoomId, card });
      };
      handEl.appendChild(btn);
    });
  }
}

function addSystemMessage(msg) {
  const div = document.createElement("div");
  div.className = "system-message";
  div.textContent = `[系统] ${msg}`;
  chatBox.appendChild(div);
  chatBox.scrollTop = chatBox.scrollHeight;
}
