import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { ChatGptSubscriptionAuth } from '../src/chatgpt-auth.js';
import { configuredModel } from '../src/pi-runtime.js';
import { PI_AGENT_MODEL_STAGES, type PiAgentRuntimeModelConfig } from '../src/presets.js';

const realFetch = globalThis.fetch;
let root: string;
let auth: ChatGptSubscriptionAuth;
let tokenRequests: URLSearchParams[];
let loginNonce: string;
let identityOverrides: Record<string, unknown>;
const { privateKey, publicKey } = await generateKeyPair('RS256');
const jwk = { ...await exportJWK(publicKey), kid: 'test-openai-key', alg: 'RS256', use: 'sig' };

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pi-chatgpt-'));
  auth = new ChatGptSubscriptionAuth(join(root, 'config', 'auth.json'));
  tokenRequests = [];
  loginNonce = '';
  identityOverrides = {};
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === 'https://auth.openai.com/.well-known/jwks.json') return Response.json({ keys: [jwk] });
    if (String(input) === 'https://auth.openai.com/api/accounts/oauth/token') {
      const params = new URLSearchParams(String(init?.body));
      tokenRequests.push(params);
      const idToken = await new SignJWT({
        iss: 'https://auth.openai.com', aud: params.get('client_id'), sub: 'test-openai-subject',
        nonce: loginNonce, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600,
        name: 'Pi Tester', email: 'pi@example.test', ...identityOverrides,
      }).setProtectedHeader({ alg: 'RS256', kid: jwk.kid }).sign(privateKey);
      return Response.json({
        access_token: 'test-subscription-access', refresh_token: 'test-subscription-refresh',
        ...(params.get('grant_type') === 'authorization_code' ? { id_token: idToken } : {}), expires_in: 3600,
        scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
      });
    }
    return realFetch(input, init);
  }));
});

afterEach(async () => {
  await auth.logout();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

async function pendingLogin() {
  await auth.startLogin();
  let view = await auth.view();
  await vi.waitFor(async () => {
    view = await auth.view();
    expect(view.authorizationUrl).toBeTruthy();
    expect(view.awaitingInput).toBe(true);
  });
  const url = new URL(view.authorizationUrl!);
  loginNonce = url.searchParams.get('nonce')!;
  const callback = new URL(url.searchParams.get('redirect_uri')!);
  callback.searchParams.set('state', url.searchParams.get('state')!);
  callback.searchParams.set('code', 'test-authorization-code');
  callback.searchParams.set('client_id', 'test-issued-client');
  return { view, url, callback };
}

function config(): PiAgentRuntimeModelConfig {
  return {
    subscriptionAuthPath: auth.authPath,
    stages: Object.fromEntries(PI_AGENT_MODEL_STAGES.map(stage => [stage, {
      authMode: 'chatgpt', apiType: 'openai', model: 'gpt-6.1-sol', effort: 'high',
      endpoint: 'https://old-proxy.example/v1', apiKey: 'retained-api-key',
    }])) as PiAgentRuntimeModelConfig['stages'],
  };
}

describe('ChatGPT subscription', () => {
  it('serializes logout and a replacement login without leaving the callback port occupied', async () => {
    await pendingLogin();
    const [signedOut, next] = await Promise.all([auth.logout(), auth.startLogin()]);
    expect(signedOut.status).toBe('signed_out');
    expect(next.status).toBe('pending');
    await vi.waitFor(async () => expect((await auth.view()).authorizationUrl).toBeTruthy());
  });

  it('logs in through the official callback, uses direct Responses, and keeps tokens outside jobs and public views', async () => {
    const { callback, url } = await pendingLogin();
    expect(url.origin).toBe('https://auth.openai.com');
    expect(url.searchParams.get('scope')).toContain('chatgpt.tokens.use.direct');
    expect(url.searchParams.get('agent_name_hint')).toBe('Acceptance Pi');
    expect((await realFetch(callback)).status).toBe(200);
    await vi.waitFor(async () => expect((await auth.view()).status).toBe('connected'));
    expect(tokenRequests[0]?.get('client_id')).toBe('test-issued-client');
    expect(JSON.stringify(await auth.view())).not.toMatch(/test-subscription|test-issued-client|authorization-code/);
    const saved = JSON.parse(await readFile(auth.authPath, 'utf8'));
    expect(saved.openai.type).toBe('oauth');
    expect(saved.openai.accountProfile).toEqual({ subject: 'test-openai-subject', name: 'Pi Tester', email: 'pi@example.test' });
    expect(saved.openai.idToken).toBeUndefined();
    expect(saved.openai.nonce).toBeUndefined();
    const account = (await auth.view()).account;
    expect(account).toEqual({ id: expect.stringMatching(/^[A-F0-9]{12}$/), name: 'Pi Tester', email: 'pi@example.test' });
    expect((await new ChatGptSubscriptionAuth(auth.authPath).view()).account).toEqual(account);
    expect((await auth.catalog()).models.some(model => model.id === 'gpt-6.1-sol')).toBe(true);
    const runtime = await configuredModel(join(root, 'job'), 'discovery', config());
    expect(runtime.model).toMatchObject({ provider: 'openai', api: 'openai-responses', baseUrl: 'https://api.openai.com/v1' });
    expect(runtime.modelRuntime.getRegisteredProviderIds()).not.toContain('acceptance-pi-discovery');
    expect((await runtime.modelRuntime.getAuth(runtime.model))?.auth.apiKey).toBe('test-subscription-access');
    const requests: Array<{ url: string; authorization: string | null; body: { model: string } }> = [];
    const transport = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      requests.push({ url: request.url, authorization: request.headers.get('authorization'), body: await request.clone().json() });
      return Response.json({ error: { message: 'simulated endpoint response', type: 'invalid_request_error' } }, { status: 400 });
    });
    await runtime.modelRuntime.completeSimple(runtime.model, {
      messages: [{ role: 'user', content: 'transport probe', timestamp: Date.now() }],
    }, { fetch: transport, maxRetries: 0, timeoutMs: 2000 });
    expect(transport).toHaveBeenCalledOnce();
    expect(requests).toEqual([{ url: 'https://api.openai.com/v1/responses', authorization: 'Bearer test-subscription-access', body: expect.objectContaining({ model: 'gpt-6.1-sol' }) }]);
    await expect(readFile(join(root, 'job', 'pi-agent-home', 'auth.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await new ChatGptSubscriptionAuth(auth.authPath).view()).connected).toBe(true);
  });

  it('supports a pasted callback, serializes concurrent starts, and reuses the installation ID', async () => {
    const { view, callback, url } = await pendingLogin();
    const starts = await Promise.all([auth.startLogin(), auth.startLogin()]);
    expect(starts.map(value => value.loginId)).toEqual([view.loginId, view.loginId]);
    auth.submitInput(view.loginId!, callback.toString());
    await vi.waitFor(async () => expect((await auth.view()).connected).toBe(true));
    const next = await pendingLogin();
    expect(next.url.searchParams.get('ext_agent_host_id')).toBe(url.searchParams.get('ext_agent_host_id'));
    await auth.cancelLogin(next.view.loginId!);
    expect((await auth.view()).connected).toBe(true);
    expect(() => auth.submitInput(next.view.loginId!, next.callback.toString())).toThrow('已失效');
  });

  it('rejects a mismatched OAuth state without replacing credentials and can cancel then retry', async () => {
    const { callback, view } = await pendingLogin();
    callback.searchParams.set('state', 'wrong-state');
    expect((await realFetch(callback)).status).toBe(400);
    expect((await auth.view()).status).toBe('pending');
    expect(tokenRequests).toHaveLength(0);
    await auth.cancelLogin(view.loginId!);
    const next = await pendingLogin();
    auth.submitInput(next.view.loginId!, next.callback.toString());
    await vi.waitFor(async () => expect((await auth.view()).connected).toBe(true));
  });

  it('refreshes a shared rotated OAuth credential only once across parallel stages and logout removes it', async () => {
    const { callback } = await pendingLogin();
    await realFetch(callback);
    await vi.waitFor(async () => expect((await auth.view()).connected).toBe(true));
    const saved = JSON.parse(await readFile(auth.authPath, 'utf8'));
    saved.openai.expires = Date.now() - 1;
    await writeFile(auth.authPath, JSON.stringify(saved));
    const runtimes = await Promise.all(['discovery', 'coverage_review'].map(stage =>
      configuredModel(join(root, stage), stage as 'discovery' | 'coverage_review', config())));
    expect(tokenRequests.filter(request => request.get('grant_type') === 'refresh_token')).toHaveLength(1);
    expect((await auth.view()).account).toMatchObject({ name: 'Pi Tester', email: 'pi@example.test' });
    expect(runtimes.every(runtime => runtime.selected.provider === 'openai')).toBe(true);
    expect((await auth.logout()).connected).toBe(false);
    expect((await auth.view()).account).toBeUndefined();
    vi.stubEnv('OPENAI_API_KEY', 'must-not-fall-back-to-billed-api');
    expect(await runtimes[0]!.modelRuntime.getAuth(runtimes[0]!.model)).toBeUndefined();
    await expect(configuredModel(join(root, 'signed-out-job'), 'discovery', config())).rejects.toThrow('尚未登录 ChatGPT');
  });

  it.each([
    { nonce: 'different-login' }, { aud: 'different-client' }, { iss: 'https://other.example' },
    { exp: 1 }, { sub: null },
  ])('rejects mismatched identity claims without replacing the current account: %j', async overrides => {
    const { callback } = await pendingLogin();
    await realFetch(callback);
    await vi.waitFor(async () => expect((await auth.view()).connected).toBe(true));
    const previous = await readFile(auth.authPath, 'utf8');
    identityOverrides = overrides;
    const next = await pendingLogin();
    await realFetch(next.callback);
    await vi.waitFor(async () => expect((await auth.view()).status).toBe('error'));
    expect(await readFile(auth.authPath, 'utf8')).toBe(previous);
    expect((await auth.view()).account).toMatchObject({ name: 'Pi Tester', email: 'pi@example.test' });
  });

  it('shows a stable registration label for an existing credential without account profile', async () => {
    const { callback } = await pendingLogin();
    await realFetch(callback);
    await vi.waitFor(async () => expect((await auth.view()).connected).toBe(true));
    const saved = JSON.parse(await readFile(auth.authPath, 'utf8'));
    const accountId = (await auth.view()).account!.id;
    delete saved.openai.accountProfile;
    await writeFile(auth.authPath, JSON.stringify(saved));
    expect((await new ChatGptSubscriptionAuth(auth.authPath).view()).account).toEqual({ id: accountId });
  });

  it('preserves the API key runtime when selected', async () => {
    const api = config();
    api.stages.discovery = { ...api.stages.discovery, authMode: 'api_key', model: 'custom-api-model' };
    const runtime = await configuredModel(join(root, 'api-job'), 'discovery', api);
    expect(runtime.model).toMatchObject({ provider: 'acceptance-pi-discovery', baseUrl: 'https://old-proxy.example/v1' });
    expect((await runtime.modelRuntime.getAuth(runtime.model))?.auth.apiKey).toBe('retained-api-key');
  });
});
