import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

export const name = 'openfars-dsh-sdk-resume';
export const inject = ['agents'];

export async function apply(ctx, config) {
  const require = createRequire(config.runtimeExecutable);
  const { HarnessSdkJsonRpcServer } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-sdk-jsonrpc-server')));
  const { JsonRpcLineTransport } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-sdk-protocol')));

  class ResumeServer extends HarnessSdkJsonRpcServer {
    async handleRequest(method, params) {
      if ((method === 'session/resume' || method === 'session/prompt') && params.sessionId !== config.sessionId) {
        throw new Error('SDK request does not match the validated native session');
      }
      if (method !== 'session/resume') return super.handleRequest(method, params);
      if (!this.initialized || this.sessions.has(params.sessionId)) {
        throw new Error('Native resume requires an initialized, unopened session');
      }
      // The upstream prompt endpoint creates a new log; only the official
      // Agent resume API loads the existing persisted session.
      const handle = await this.ctx.agents.resume({
        resumeSessionId: params.sessionId,
        agentOptions: { provider: this.provider, model: this.model }
      });
      this.sessions.set(params.sessionId, { handle });
      const events = [...handle.agent.session.ownEvents()];
      return { sessionId: params.sessionId, lastSequence: events.at(-1)?.seq ?? -1 };
    }
  }

  const transport = new JsonRpcLineTransport(process.stdin, process.stdout);
  const server = new ResumeServer(ctx, transport, { maxTokensAsSuccess: false });
  const rootFiber = ctx.root.fiber;
  let exitTask;
  const disposeAndExit = () => exitTask ??= (async () => {
    await Promise.allSettled([Promise.resolve().then(() => transport.flush())]);
    await Promise.allSettled([Promise.resolve().then(() => rootFiber.dispose())]);
    process.exit(0);
  })();
  transport.onRequest(async (method, params) => {
    if (method === 'initialize') await ctx.get('loader')?.await();
    const result = await server.handleRequest(method, params);
    if (method === 'shutdown') setImmediate(disposeAndExit);
    return result;
  });
  ctx.effect(() => {
    transport.start();
    return async () => {
      await server.shutdown();
      transport.close();
    };
  }, 'openfars.jsonrpc.resume');
}
