const $ = (id) => document.getElementById(id);

let channelId = "";
let warning = "";

const api = async (path, body) => {
  const res = await fetch(path, {
    method: body ? "POST" : "GET",
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
};

const log = (text) => {
  $("log").textContent = text || "";
};

const busy = async (button, fn) => {
  button.disabled = true;
  try {
    await fn();
  } catch (err) {
    log(err.message);
  } finally {
    button.disabled = false;
  }
};

async function init() {
  const me = await api("/api/me");
  $("login").hidden = me.loggedIn;
  $("logout").hidden = !me.loggedIn;
  $("app").hidden = !me.loggedIn;
  $("me").textContent = me.loggedIn ? `@${me.user.name}` : "Login required";
}

$("login").onclick = () => location.href = "/login";
$("logout").onclick = () => busy($("logout"), async () => {
  await api("/logout", {});
  location.reload();
});

$("resolve").onclick = () => busy($("resolve"), async () => {
  const data = await api("/api/resolve-channel", { input: $("channel").value });
  channelId = data.channel.id;
  $("channelStatus").textContent = `#${data.channel.path}`;
  log("");
});

$("review").onclick = () => busy($("review"), async () => {
  if (!channelId) throw new Error("Set channel first");
  const draft = $("draft").value.trim();
  if (!draft) throw new Error("Draft is empty");
  $("stopBox").hidden = true;
  $("finalBox").hidden = true;
  log("reviewing...");
  const result = await api("/api/review", { channelId, draft });
  if (result.action === "posted") {
    $("draft").value = "";
    log(`posted: ${result.message.id}`);
    return;
  }
  warning = result.warning;
  $("warning").textContent = warning;
  $("stopBox").hidden = false;
  log("");
});

$("rewrite").onclick = () => busy($("rewrite"), async () => {
  const userIntent = $("intent").value.trim();
  if (!userIntent) throw new Error("Tell QodeX what to do");
  log("drafting...");
  const result = await api("/api/rewrite", {
    channelId,
    originalDraft: $("draft").value,
    warning,
    userIntent,
  });
  $("finalPost").value = result.post;
  $("finalBox").hidden = false;
  log("");
});

$("post").onclick = () => busy($("post"), async () => {
  const content = $("finalPost").value.trim();
  if (!content) throw new Error("Final post is empty");
  const result = await api("/api/post", { channelId, content });
  $("draft").value = "";
  $("intent").value = "";
  $("finalPost").value = "";
  $("stopBox").hidden = true;
  $("finalBox").hidden = true;
  log(`posted: ${result.message.id}`);
});

$("again").onclick = () => {
  $("intent").focus();
};

init().catch((err) => log(err.message));
