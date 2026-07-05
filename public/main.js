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
      try {
        const me = await this.api("/api/me");
        if (!me.loggedIn) {
          this.log = "Login required";
          return;
        }
        this.me = me.user;
        this.log = "";
        const { channels } = await this.api("/api/channels");
        this.channels = channels;
      } catch (err) {
        this.log = err.message === "forbidden" ? "This QodeX is private" : err.message;
      }
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

          <section v-if="warning" class="qodex-panel qodex-warning">
            <strong>AI warning</strong>
            <p>{{ warning }}</p>
            <textarea ref="intent" v-model="intent" rows="3" placeholder="どう直すか、送らないか、追加で聞きたいことを書く"></textarea>
            <button @click="rewrite" :disabled="busy">AI に最終文を作らせる</button>
          </section>

          <section v-if="finalPost" class="qodex-panel qodex-final">
            <strong>AI drafted final post</strong>
            <textarea v-model="finalPost" rows="4" readonly></textarea>
            <div class="final-actions">
              <button @click="postFinal" :disabled="busy">Post</button>
              <button class="secondary" @click="$refs.intent?.focus?.()">Discuss more</button>
            </div>
          </section>

          <form class="message-input" @submit.prevent="review">
            <div class="input-container">
              <div class="left-controls" aria-hidden="true">
                <button type="button" class="input-icon" tabindex="-1" title="Upload">
                  <svg viewBox="0 0 24 24"><path d="M12 3l5 5h-3v7h-4V8H7l5-5zM5 19h14v2H5v-2z"/></svg>
                </button>
                <button type="button" class="input-icon" tabindex="-1" title="Preview">
                  <svg viewBox="0 0 24 24"><path d="M12 5c5 0 9 5 9 7s-4 7-9 7-9-5-9-7 4-7 9-7zm0 2c-3.9 0-6.9 3.4-7 5 .1 1.6 3.1 5 7 5s6.9-3.4 7-5c-.1-1.6-3.1-5-7-5zm0 2.5A2.5 2.5 0 1 1 12 14a2.5 2.5 0 0 1 0-5z"/></svg>
                </button>
              </div>
              <div class="textarea-container">
                <textarea class="message-textarea" v-model="draft" rows="2" :placeholder="channel ? 'メッセージを入力' : '先にチャンネルを選択'"></textarea>
                <div class="textarea-over"></div>
              </div>
              <div class="right-controls">
                <span class="input-log">{{ log }}</span>
                <button type="button" class="input-icon" tabindex="-1" title="Stamp" aria-label="Stamp">
                  <svg viewBox="0 0 24 24"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM8 9.2a1.2 1.2 0 1 1 0-2.4 1.2 1.2 0 0 1 0 2.4zm8 0a1.2 1.2 0 1 1 0-2.4 1.2 1.2 0 0 1 0 2.4zm-4 8.1c-2.4 0-4.4-1.3-5.5-3.3h11c-1.1 2-3.1 3.3-5.5 3.3z"/></svg>
                </button>
                <button type="submit" class="send-button" :disabled="busy || !channel || !draft.trim()" title="Review & Post" aria-label="Review and post">
                  <svg viewBox="0 0 24 24"><path d="M3 20.5 21 12 3 3.5V10l11 2-11 2v6.5z"/></svg>
                </button>
              </div>
            </div>
          </form>
        </section>
      </main>
    </div>
  `,
}).mount("#app");
