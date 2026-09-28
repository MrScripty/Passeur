// Fixture-only native-to-candidate protocol composition. No Meta account or live network.
import { createServer as createTlsServer } from 'node:https';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, realpath } from 'node:fs/promises';
import { join, dirname, isAbsolute, sep } from 'node:path';
import { startShellProvider, shellCommitCommand } from './qualify-muse-sandbox-transport.mjs';
import { startProviderTransport } from '../dist/src/muse/provider-transport.js';

const CERT = "-----BEGIN CERTIFICATE-----\nMIIDJTCCAg2gAwIBAgIUemlCZFSlCzOWt/BGL8Y7YLC1ZsowDQYJKoZIhvcNAQEL\nBQAwFjEUMBIGA1UEAwwLYXBpLm1ldGEuYWkwHhcNMjYwOTI4MjIwNTAyWhcNMzYw\nOTI1MjIwNTAyWjAWMRQwEgYDVQQDDAthcGkubWV0YS5haTCCASIwDQYJKoZIhvcN\nAQEBBQADggEPADCCAQoCggEBALB8Og7Tzngm4XZQyGEF3x/KztnwWVcP0hd96fax\niQNb/Mry3wFbfQ+D3MK23d3Si2zZue0s+f0BsOPwgPfE/DgxwDNSjvZwjgMxqAGW\n3BotuwmS38W5RsPM2ykzpDJfI+uYAxdukE4CAqg2orxRo4lT4SVFYliDrzc8hRR0\nPdyuQ75+7jrCcSbaNVVSMKYtdUt0tPj5FXKpWCqw2m65KQmXlP8xaf6lhvrm7qDH\nTYvdiQVptPZEEcwf5xwe4qIV5zZZQB/IrkM34WEe+J+eC52DckvsmO8ozrHVuPSJ\nfcmRZTTgnpVy/C9E/Jui2GfSlVf6PMJc6Pl/PM5HV0i1+L0CAwEAAaNrMGkwHQYD\nVR0OBBYEFC3NLfZJmMZn1qDyjXQcydMOOl4nMB8GA1UdIwQYMBaAFC3NLfZJmMZn\n1qDyjXQcydMOOl4nMA8GA1UdEwEB/wQFMAMBAf8wFgYDVR0RBA8wDYILYXBpLm1l\ndGEuYWkwDQYJKoZIhvcNAQELBQADggEBAIV5IPqAL7mLKS5Nd688wDUmCS1kqCdK\n7LwrR98wZoQ0nyGn+vE8kj0jDO5+QvhcL3LYTSP5vELxeR2YtXND5rDlzC/0ozR1\ne+iTNFJNmgbcBjk6B57fBTmaK9PzQacd9trfTeDKpSO4UjLrXf66l4mjJ5nnHoyb\nGCbjvZJoeyhl/jeRToL6NQNIeVqJsV+5R+aUsjK2yd65mXZFkafA5kGAIk5fgs5g\nzuzvevmGd11FCTzmgtLNLm+Br05kD6hcqe2vNNVYnQiwvhS6Gs+P9sHh1yxmveYF\ngCHi/KJ509xuACu5vqVwWcpnPTAcC+d5vqgWw86MxO+qnpjJAEq2BWg=\n-----END CERTIFICATE-----\n";

const KEY = "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCwfDoO0854JuF2\nUMhhBd8fys7Z8FlXD9IXfen2sYkDW/zK8t8BW30Pg9zCtt3d0ots2bntLPn9AbDj\n8ID3xPw4McAzUo72cI4DMagBltwaLbsJkt/FuUbDzNspM6QyXyPrmAMXbpBOAgKo\nNqK8UaOJU+ElRWJYg683PIUUdD3crkO+fu46wnEm2jVVUjCmLXVLdLT4+RVyqVgq\nsNpuuSkJl5T/MWn+pYb65u6gx02L3YkFabT2RBHMH+ccHuKiFec2WUAfyK5DN+Fh\nHvifngudg3JL7JjvKM6x1bj0iX3JkWU04J6VcvwvRPybothn0pVX+jzCXOj5fzzO\nR1dItfi9AgMBAAECggEAA3xiYZ08dQa73BoClzTc8osPWT27Hpa3Ot0Of7sV551C\noKpMDkIO0WsZKkj6vNE6sdiHhBKDYx/VdjhB2ieQ3aO1o8JxqWAaiyAbWrz3sQ0b\n+K5nBggESI5H1cOb0zAqPwBtU32xZVdWLnS/POlanAhS2qk2yYkknMzMLtXZp6tc\n9buFN/Mc5k0VTvJl6nZZ0j4jI/t4alu07PiDmmmXYvpZk1ty1KzRHUstEBWKx1Zt\nmKuBI5/8dubvZenEi53DPSpfXm2kdxjQnwt2sXx6QyWuiiQdImAs+wUjHxUBQ29u\n+G5rtQoR3cm1GLUvdSM0RvxmGoS6SoPzqEPfkk89CQKBgQDWcBQ/H8hd0z1Xux2W\nE2eQAhtN/k9Q4J5A20FiuZvEqlEm2Lav9/E0fpS0u+4BzxpoiJfOFsznEKydfNG5\nrSHzholaEBnbKQyzTNPRWTzuYKW/H3EBFo93txso0vW79fPK+NyKnSuUcrbXUGCR\nnp9I5cj10uDYCHxZpStib+5SWQKBgQDSsQccoX9iiqFUOi9ZCOKO0swUaONk7atR\nCWkC8RARi1ZIhRO3plXVAo96G+8VjzFk4X2gyCzPisx74KiDt/zGJsKMvv/hRdVg\nm5cur9iipBp7mfjUfAE3U5Y5U0wVbCjcqSzz4+zKeICbhJG1ydbhpLxxl2gSs5Xd\nBbQDgHOlBQKBgCWcnQCBa5yBW6YSrNrQ5n5M0Es6yuCttTQ9ANf3JEo3cWp14n00\n6PrDJQQaXmG02LXzF2VPfHse4pfw97wwkN7s/xRr9I0LQy4D0LdMhrJtA0Vll2WQ\ndnOSC1J6xh1Ew5EbW1t4u9ca09UqRPXls5yOqVPsvAFIY785iEWIym1pAoGBAK8V\nd4B+YDpGU6yHsaL+dC8V04u+YgEUVEJCXKaaJq09qhUXqXv62ObresmRfwvec8CO\ndfRvhHVvtV/YIJFdCsyrlw6ZBlBw1NG0WlzsukzlrDA8koAZEHWmm3bF1rsSp54/\nY+DE7piOrOkPsHpt4Yifeg23MUAhRo9mVuJ2EyP1AoGABFSZOKMMjA9n8HJkUutg\ncTM7ntkYj+Syq/x9nqoNIoF+kdYqgV0DudLsMpFLb2KBm9JPpjcAM1VvEDaHr2N5\nZ1bgqHShYG5vcSWEje1gaw534e0dyty8C2qy8oAgJ8B6rtaqz+4hOrzPcoFJLXf4\nn1hW7lRBu1lKu+uIUpskp68=\n-----END PRIVATE KEY-----\n";

const lookup = (_host, options, callback) => queueMicrotask(() => options.all
  ? callback(null, [{ address: '127.0.0.1', family: 4 }])
  : callback(null, '127.0.0.1', 4));
const DUMMY = 'passeur-disposable-dummy-key';

export function fixtureRoute(method, path) {
  if (method === 'GET' && path === '/v1/models') return '/muse-code/models';
  if (method === 'POST' && path === '/v1/responses') return '/responses';
  return null;
}

function overlaps(a, b) {
  return a === b || a.startsWith(`${b}${sep}`) || b.startsWith(`${a}${sep}`);
}

export async function assertHostOnlyProviderDirectory(directory, guestMountSources) {
  if (!isAbsolute(directory) || !Array.isArray(guestMountSources) ||
      guestMountSources.length < 2 || guestMountSources.some(path => !isAbsolute(path))) {
    throw new Error('FIXTURE_PROVIDER_MOUNT_INVALID');
  }
  const owned = await realpath(directory);
  for (const source of guestMountSources) {
    if (overlaps(owned, await realpath(source))) {
      throw new Error('FIXTURE_PROVIDER_MOUNT_OVERLAP');
    }
  }
  return owned;
}

export async function startFixtureProviderTransport({ workspace, protectedRoot, canaryToken,
  hostPort, shell, taskCommit, adapterMode, signal, guestMountSources, testPeer = {} }) {
  if (!shell || !taskCommit || typeof protectedRoot !== 'string' ||
      typeof workspace !== 'string' || !workspace.startsWith('/tmp/')) {
    throw new Error('FIXTURE_PROVIDER_CONFIG_INVALID');
  }
  const seen = [];
  const secret = randomBytes(32).toString('hex');
  const providerDirectory = join(dirname(protectedRoot), 'provider-transport');
  await mkdir(providerDirectory, { mode: 0o700 });
  await assertHostOnlyProviderDirectory(providerDirectory, guestMountSources);
  const socketPath = join(providerDirectory, 'provider.sock');
  let transport;
  const provider = await startShellProvider(hostPort,
    shellCommitCommand(workspace, protectedRoot, canaryToken), {
      outerOnly: true, taskCommit: true, adapterMode,
      resultEvidenceDir: protectedRoot, workspace, protectedRoot, canaryToken,
      makeServer: handler => createTlsServer({ key: KEY, cert: CERT }, (request, response) => {
        const route = fixtureRoute(request.method, request.url);
        const correctBearer = request.headers.authorization === `Bearer ${secret}`;
        const dummyAbsent = !JSON.stringify(request.headers).includes(DUMMY);
        const runHeaderAbsent = request.headers['x-passeur-run'] === undefined;
        const observation = { method: request.method, path: request.url, correctBearer,
          dummyAbsent, runHeaderAbsent, tls: request.socket.encrypted === true };
        seen.push(observation);
        if (!route || !correctBearer || !dummyAbsent || !runHeaderAbsent) {
          response.writeHead(403).end(); return;
        }
        request.url = route;
        const digest = createHash('sha256');
        request.on('data', chunk => digest.update(chunk));
        request.once('end', () => { observation.bodySha256 = digest.digest('hex'); });
        handler(request, response);
      }),
  });
  try {
    transport = await startProviderTransport({ socketPath,
      getBearer: async () => ({ value: secret, expiresAt: Date.now() + 60_000 }),
      signal, testPeer: { port: provider.port, lookup, ca: CERT, ...testPeer } });
  } catch (error) {
    await provider.close();
    throw error;
  }
  return { origin: 'http://127.0.0.1:1/', transportSocketPath: socketPath,
    provider, seen, close: async () => {
      let error;
      try { await transport.close(); } catch (cause) { error = cause; }
      try { await provider.close(); } catch (cause) { error ??= cause; }
      if (error) throw error;
    } };
}
