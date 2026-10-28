import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ModelRuntime, readStoredCredential } from "@earendil-works/pi-coding-agent";
import type { AuthPrompt } from "@earendil-works/pi-ai";
import { createRemoteJWKSet, jwtVerify } from "jose";

const OPENAI_ISSUER = "https://auth.openai.com";
const openaiKeys = createRemoteJWKSet(new URL(`${OPENAI_ISSUER}/.well-known/jwks.json`));

export interface ChatGptSubscriptionView {
  connected: boolean;
  status: "signed_out" | "pending" | "connected" | "error";
  loginId?: string;
  authorizationUrl?: string;
  awaitingInput?: boolean;
  message?: string;
  account?: { id: string; name?: string; email?: string };
}

type LoginAttempt = {
  id: string;
  controller: AbortController;
  view: ChatGptSubscriptionView;
  done: Promise<void>;
  input?: (value: string) => void;
};

/** Uses Pi's official OpenAI OAuth and its locked, automatically refreshed store. */
export class ChatGptSubscriptionAuth {
  private runtime?: Promise<ModelRuntime>;
  private attempt: LoginAttempt | undefined;
  private operations = Promise.resolve();

  constructor(readonly authPath: string) {}

  private models(): Promise<ModelRuntime> {
    return this.runtime ??= ModelRuntime.create({
      authPath: this.authPath, modelsPath: null, allowModelNetwork: false,
    }).then(runtime => {
      const provider = runtime.getProvider("openai")!;
      const oauth = provider.auth!.oauth!;
      runtime.registerNativeProvider({ ...provider, auth: { oauth: {
        ...oauth,
        async login(interaction, options) {
          const credential = await oauth.login(interaction, options);
          if (typeof credential.idToken !== "string" || typeof credential.clientId !== "string"
            || typeof credential.nonce !== "string") throw new Error("OpenAI identity is missing");
          const { payload } = await jwtVerify(credential.idToken, openaiKeys, {
            issuer: OPENAI_ISSUER, audience: credential.clientId,
            requiredClaims: ["sub", "exp", "iat"], clockTolerance: 5,
          });
          if (payload.nonce !== credential.nonce || typeof payload.sub !== "string" || !payload.sub) {
            throw new Error("OpenAI identity did not match this login");
          }
          credential.accountProfile = {
            subject: payload.sub,
            ...(displayText(payload.name) ? { name: displayText(payload.name) } : {}),
            ...(displayText(payload.email) ? { email: displayText(payload.email) } : {}),
          };
          delete credential.idToken;
          delete credential.nonce;
          return credential;
        },
      } } });
      return runtime;
    });
  }

  async view(): Promise<ChatGptSubscriptionView> {
    await this.models();
    const credential = readStoredCredential("openai", this.authPath);
    const connected = credential?.type === "oauth";
    const profile = connected && credential.accountProfile && typeof credential.accountProfile === "object"
      ? credential.accountProfile as Record<string, unknown> : {};
    const name = displayText(profile.name);
    const email = displayText(profile.email);
    const account = connected && typeof credential.clientId === "string" ? {
      id: createHash("sha256").update(credential.clientId).digest("hex").slice(0, 12).toUpperCase(),
      ...(name ? { name } : {}),
      ...(email ? { email } : {}),
    } : undefined;
    return this.attempt
      ? { ...this.attempt.view, connected, ...(account ? { account } : {}) }
      : { connected, status: connected ? "connected" : "signed_out", ...(account ? { account } : {}) };
  }

  startLogin(): Promise<ChatGptSubscriptionView> {
    return this.exclusive(() => this.start());
  }

  private async start(): Promise<ChatGptSubscriptionView> {
    if (this.attempt?.view.status === "pending") return this.view();
    const runtime = await this.models();
    const deviceId = await this.deviceId();
    const attempt: LoginAttempt = {
      id: randomUUID(), controller: new AbortController(),
      view: { connected: false, status: "pending", message: "正在准备 ChatGPT 登录…" },
      done: Promise.resolve(),
    };
    attempt.view.loginId = attempt.id;
    this.attempt = attempt;
    const timeout = setTimeout(() => attempt.controller.abort(), 15 * 60 * 1000);
    timeout.unref();
    attempt.done = runtime.login("openai", "oauth", {
      signal: attempt.controller.signal,
      notify: event => {
        if (event.type === "auth_url") {
          attempt.view.authorizationUrl = event.url;
          attempt.view.message = "在浏览器中登录并授权使用 ChatGPT 套餐。";
        } else if (event.type === "progress") {
          attempt.view.message = "正在完成 ChatGPT 登录…";
        }
      },
      prompt: prompt => this.prompt(attempt, prompt),
    }, { getDeviceId: () => deviceId, agentName: "Acceptance Pi" })
      .then(() => {
        attempt.view = { connected: true, status: "connected", message: "ChatGPT 已连接" };
      })
      .catch(error => {
        attempt.view = {
          connected: false, status: "error",
          message: attempt.controller.signal.aborted
            ? "登录已取消或超时，请重新登录。"
            : error instanceof Error && /Port 1455 is in use/.test(error.message)
              ? "登录端口 1455 被占用，请取消其他 Pi 或 Codex 的待完成登录后重试。"
              : "ChatGPT 登录失败，请确认账号允许使用订阅额度后重新登录。",
        };
      })
      .finally(() => { clearTimeout(timeout); delete attempt.input; });
    return this.view();
  }

  submitInput(loginId: string, value: unknown): void {
    const attempt = this.attempt;
    if (!attempt || attempt.id !== loginId || attempt.view.status !== "pending" || !attempt.input) {
      throw new Error("登录请求已失效，请重新登录。");
    }
    if (typeof value !== "string" || !value.trim() || value.length > 8192) {
      throw new Error("请粘贴浏览器登录后的完整回调地址（不超过 8192 字符）。");
    }
    const resolve = attempt.input;
    delete attempt.input;
    attempt.view.awaitingInput = false;
    resolve(value.trim());
  }

  cancelLogin(loginId: string): Promise<ChatGptSubscriptionView> {
    return this.exclusive(() => this.cancel(loginId));
  }

  private async cancel(loginId: string): Promise<ChatGptSubscriptionView> {
    const attempt = this.attempt;
    if (!attempt || attempt.id !== loginId) throw new Error("登录请求已失效。");
    attempt.controller.abort();
    await attempt.done;
    if (this.attempt === attempt) this.attempt = undefined;
    return this.view();
  }

  logout(): Promise<ChatGptSubscriptionView> {
    return this.exclusive(async () => {
      if (this.attempt) await this.cancel(this.attempt.id);
      await (await this.models()).logout("openai");
      return this.view();
    });
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operations.then(operation, operation);
    this.operations = result.then(() => {}, () => {});
    return result;
  }

  async catalog(): Promise<{ models: Array<{ id: string; name: string }> }> {
    if (!(await this.view()).connected) throw new Error("请先登录 ChatGPT 订阅，再加载模型清单。");
    return { models: (await this.models()).getModels("openai").map(model => ({ id: model.id, name: model.name })) };
  }

  private prompt(attempt: LoginAttempt, prompt: AuthPrompt): Promise<string> {
    if (prompt.type !== "manual_code") return Promise.reject(new Error("Unexpected OpenAI login prompt"));
    attempt.view.awaitingInput = true;
    const signal = prompt.signal ?? attempt.controller.signal;
    return new Promise((resolve, reject) => {
      const cleanup = () => { signal.removeEventListener("abort", abort); delete attempt.input; };
      const abort = () => { cleanup(); reject(new Error("Login cancelled")); };
      attempt.input = value => { cleanup(); resolve(value); };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
  }

  private async deviceId(): Promise<string> {
    const path = join(dirname(this.authPath), "installation.json");
    await mkdir(dirname(path), { recursive: true });
    try {
      await writeFile(path, JSON.stringify({ deviceId: randomUUID() }), { encoding: "utf8", flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const stored = JSON.parse(await readFile(path, "utf8")) as { deviceId: string };
    return stored.deviceId;
  }
}

function displayText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() && value.length <= 320 ? value.trim() : undefined;
}
