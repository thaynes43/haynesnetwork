// ADR-060 / DESIGN-031 D-08 (PLAN-035) — the hermetic SMTP stub: a minimal node:net SMTP server
// (220 greeting → EHLO → AUTH PLAIN/LOGIN accepted blind → MAIL/RCPT/DATA → QUIT) that RECORDS
// every delivered message, plus the stub-arr-idiom HTTP recorder (`/_stub/messages` +
// `/_stub/reset`) so a spec can assert what the notify-outbox drainer actually sent. No TLS —
// nodemailer's `secure:false` submission proceeds plaintext when STARTTLS is not advertised
// (the production path to smtp.gmail.com:587 upgrades; the wire protocol above it is identical).
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { createServer as createNetServer, type Server as NetServer, type Socket } from 'node:net';

export const STUB_SMTP_USER = 'stub-smtp-user';
export const STUB_SMTP_PASS = 'stub-smtp-pass';
export const STUB_SMTP_FROM = 'noreply@haynesnetwork.com';

export interface RecordedMail {
  from: string;
  to: string[];
  /** The raw DATA block (headers + body, dot-unstuffed not needed for assertions). */
  data: string;
}

export interface StubSmtpServer {
  /** The SMTP listener's port (env SMTP_PORT; host 127.0.0.1). */
  port: number;
  /** The HTTP recorder origin (GET /_stub/messages, POST /_stub/reset). */
  recorderUrl: string;
  stop: () => Promise<void>;
}

function handleConnection(socket: Socket, messages: RecordedMail[]): void {
  let buffer = '';
  let inData = false;
  let current: { from: string; to: string[]; data: string } = { from: '', to: [], data: '' };
  const reply = (line: string) => socket.write(`${line}\r\n`);
  reply('220 stub-smtp ready');

  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    for (;;) {
      const nl = buffer.indexOf('\r\n');
      if (nl === -1) return;
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 2);

      if (inData) {
        if (line === '.') {
          messages.push({ ...current, to: [...current.to] });
          current = { from: '', to: [], data: '' };
          inData = false;
          reply('250 OK: queued');
        } else {
          current.data += `${line.startsWith('..') ? line.slice(1) : line}\n`;
        }
        continue;
      }

      const upper = line.toUpperCase();
      if (upper.startsWith('EHLO') || upper.startsWith('HELO')) {
        socket.write('250-stub-smtp\r\n250-AUTH PLAIN LOGIN\r\n250 OK\r\n');
      } else if (upper.startsWith('AUTH')) {
        // AUTH PLAIN <b64> arrives inline; AUTH LOGIN would prompt — accept either blindly (the
        // stub verifies DELIVERY mechanics, not credentials; smtpSenderFromEnv gates those).
        reply(upper === 'AUTH LOGIN' ? '334 VXNlcm5hbWU6' : '235 Authentication succeeded');
      } else if (upper.startsWith('MAIL FROM:')) {
        current.from = line.slice('MAIL FROM:'.length).trim().replace(/^<|>$/g, '');
        reply('250 OK');
      } else if (upper.startsWith('RCPT TO:')) {
        current.to.push(line.slice('RCPT TO:'.length).trim().replace(/^<|>$/g, ''));
        reply('250 OK');
      } else if (upper === 'DATA') {
        inData = true;
        reply('354 End data with <CR><LF>.<CR><LF>');
      } else if (upper === 'QUIT') {
        reply('221 Bye');
        socket.end();
      } else {
        // RSET / NOOP / the AUTH LOGIN base64 turns land here — accept.
        reply('250 OK');
      }
    }
  });
  socket.on('error', () => socket.destroy());
}

export async function startStubSmtp(): Promise<StubSmtpServer> {
  const messages: RecordedMail[] = [];

  const smtp: NetServer = createNetServer((socket) => handleConnection(socket, messages));
  await new Promise<void>((resolve) => smtp.listen(0, '127.0.0.1', resolve));
  const smtpAddress = smtp.address();
  if (smtpAddress === null || typeof smtpAddress === 'string') throw new Error('stub-smtp: no port');

  const recorder: HttpServer = createHttpServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (path === '/_stub/messages' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ messages }));
      return;
    }
    if (path === '/_stub/reset' && req.method === 'POST') {
      messages.length = 0;
      res.writeHead(204);
      res.end();
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ message: `stub-smtp: no handler for ${req.method} ${path}` }));
  });
  await new Promise<void>((resolve) => recorder.listen(0, '127.0.0.1', resolve));
  const recAddress = recorder.address();
  if (recAddress === null || typeof recAddress === 'string') throw new Error('stub-smtp: no recorder port');

  return {
    port: smtpAddress.port,
    recorderUrl: `http://127.0.0.1:${recAddress.port}`,
    stop: async () => {
      await new Promise<void>((resolve, reject) => recorder.close((e) => (e ? reject(e) : resolve())));
      await new Promise<void>((resolve, reject) => smtp.close((e) => (e ? reject(e) : resolve())));
    },
  };
}
