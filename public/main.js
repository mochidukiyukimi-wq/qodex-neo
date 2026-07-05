const { createApp } = Vue;

createApp({
  data() {
    return {
      me: null,
      channels: [],
      channelInput: "",
      channel: null,
      messages: [],
      draft: "",
      warning: "",
      intent: "",
      finalPost: "",
      log: "checking...",
      busy: false,
    };
  },
  computed: {
    loggedIn() {
      return !!this.me;
    },
    visibleChannels() {
      const q = this.channelInput.trim().replace(/^#/, "").toLowerCase();
      return this.channels.filter(c => !q || c.path.toLowerCase().includes(q)).slice(0, 40);
    },
  },
  async mounted() {
    await this.init();
  },
  methods: {
    async api(path, body) {
      const res = await fetch(path, {
        method: body ? "POST" : "GET",
        headers: body ? { "content-type": "application/json" } : {},
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
      return data;
    },
    async run(fn) {
      this.busy = true;
      try {
        await fn();
      } catch (err) {
        this.log = err.message;
      } finally {
        this.busy = false;
      }
    },
    async init() {
      const me = await this.api("/api/me");
      if (!me.loggedIn) {
        this.log = "Login required";
        return;
      }
      this.me = me.user;
      this.log = "";
      const { channels } = await this.api("/api/channels");
      this.channels = channels;
    },
    login() {
      location.href = "/login";
    },
    async logout() {
      await this.run(async () => {
        await this.api("/logout", {});
        location.reload();
      });
    },
    async selectChannel(channel) {
      await this.run(async () => {
        this.channel = channel;
        this.channelInput = channel.path;
        this.warning = "";
        this.finalPost = "";
        await this.loadMessages();
      });
    },
    async resolveChannel() {
      await this.run(async () => {
        const { channel } = await this.api("/api/resolve-channel", { input: this.channelInput });
        this.channel = channel;
        await this.loadMessages();
      });
    },
    async loadMessages() {
      if (!this.channel) return;
      const { messages } = await this.api("/api/messages", { channelId: this.channel.id });
      this.messages = messages;
      this.$nextTick(() => {
        const list = this.$refs.messages;
        if (list) list.scrollTop = list.scrollHeight;
      });
    },
    async review() {
      await this.run(async () => {
        if (!this.channel) throw new Error("チャンネルを選んでください");
        const draft = this.draft.trim();
        if (!draft) return;
        this.warning = "";
        this.finalPost = "";
        this.log = "AI checking...";
        const result = await this.api("/api/review", { channelId: this.channel.id, draft });
        if (result.action === "posted") {
          this.draft = "";
          this.log = "posted";
          await this.loadMessages();
          return;
        }
        this.warning = result.warning;
        this.log = "";
      });
    },
    async rewrite() {
      await this.run(async () => {
        if (!this.intent.trim()) throw new Error("どうしたいかを書いてください");
        this.log = "AI drafting...";
        const result = await this.api("/api/rewrite", {
          channelId: this.channel.id,
          originalDraft: this.draft,
          warning: this.warning,
          userIntent: this.intent,
        });
        this.finalPost = result.post;
        this.log = "";
      });
    },
    async postFinal() {
      await this.run(async () => {
        if (!this.finalPost.trim()) return;
        await this.api("/api/post", { channelId: this.channel.id, content: this.finalPost });
        this.draft = "";
        this.intent = "";
        this.finalPost = "";
        this.warning = "";
        this.log = "posted";
        await this.loadMessages();
      });
    },
    formatTime(value) {
      return new Date(value).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });
    },
  },
  template: `
    <div class="traq">
      <aside class="global-nav">
        <div class="service-icon">Q</div>
        <button v-if="!loggedIn" @click="login">login</button>
        <button v-else @click="logout">logout</button>
      </aside>

      <aside class="channel-nav">
        <div class="nav-title">Channels</div>
        <form class="channel-search" @submit.prevent="resolveChannel">
          <input v-model="channelInput" placeholder="Search or paste traQ URL">
          <button :disabled="busy">Go</button>
        </form>
        <button
          v-for="c in visibleChannels"
          :key="c.id"
          class="channel-row"
          :class="{ active: channel && channel.id === c.id }"
          @click="selectChannel(c)"
        >
          <span>#</span>{{ c.path }}
        </button>
      </aside>

      <main class="main-view">
        <header class="channel-header">
          <div>
            <h1>{{ channel ? '#' + channel.path : 'チャンネルを選択' }}</h1>
            <p>{{ loggedIn ? '@' + me.name : log }}</p>
          </div>
          <button v-if="channel" @click="loadMessages" :disabled="busy">reload</button>
        </header>

        <section v-if="!loggedIn" class="empty">
          <button @click="login">traQ Login</button>
        </section>

        <section v-else class="timeline">
          <div ref="messages" class="messages">
            <article v-for="m in messages" :key="m.at + m.user + m.content" class="message">
              <div class="avatar">{{ (m.user[0] || '?').toUpperCase() }}</div>
              <div class="message-main">
                <div class="meta">
                  <strong>@{{ m.user }}</strong>
                  <time>{{ formatTime(m.at) }}</time>
                </div>
                <div class="content">{{ m.content }}</div>
              </div>
            </article>
          </div>

          <section v-if="warning" class="qodex-warning">
            <strong>AI warning</strong>
            <p>{{ warning }}</p>
            <textarea ref="intent" v-model="intent" rows="3" placeholder="どう直すか、送らないか、追加で聞きたいことを書く"></textarea>
            <button @click="rewrite" :disabled="busy">AI に最終文を作らせる</button>
          </section>

          <section v-if="finalPost" class="qodex-final">
            <strong>AI drafted final post</strong>
            <textarea v-model="finalPost" rows="4" readonly></textarea>
            <div class="final-actions">
              <button @click="postFinal" :disabled="busy">Post</button>
              <button class="secondary" @click="$refs.intent?.focus?.()">Discuss more</button>
            </div>
          </section>

          <form class="message-input" @submit.prevent="review">
            <textarea v-model="draft" rows="3" :placeholder="channel ? 'メッセージを入力' : '先にチャンネルを選択'"></textarea>
            <div class="input-tools">
              <span>{{ log }}</span>
              <button :disabled="busy || !channel">Review & Post</button>
            </div>
          </form>
        </section>
      </main>
    </div>
  `,
}).mount("#app");
