import net from 'node:net';

// Test doubles for the two proxy kinds tgpilot can talk to: an HTTP CONNECT
// relay and a SOCKS5 server. Both are deliberately small — they only have to
// behave like the real thing for one request.

// HTTP CONNECT: accepts "CONNECT host:port", replies 200 and pipes bytes.
export function startConnectProxy({ requireAuth = false } = {}) {
  const server = net.createServer((client) => {
    client.on('error', () => {});
    let head = Buffer.alloc(0);
    const onHead = (chunk) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf('\r\n\r\n');
      if (end === -1) return;
      client.removeListener('data', onHead);
      const request = head.subarray(0, end).toString('latin1');
      const match = /CONNECT ([^:]+):(\d+)/.exec(request);
      if (!match) {
        client.end('HTTP/1.1 403 Denied\r\n\r\n');
        return;
      }
      if (requireAuth && !/^proxy-authorization:/im.test(request)) {
        client.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
        return;
      }
      const upstream = net.connect(Number(match[2]), match[1], () => {
        client.write('HTTP/1.1 200 Connection established\r\n\r\n');
        const rest = head.subarray(end + 4);
        if (rest.length) upstream.write(rest);
        client.pipe(upstream);
        upstream.pipe(client);
      });
      client.on('error', () => upstream.destroy());
      upstream.on('error', () => client.destroy());
    };
    client.on('data', onHead);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

// SOCKS5: greets first, optional user/pass, CONNECT with domain or IPv4.
export function startSocks5Proxy({ user = null, password = null } = {}) {
  const server = net.createServer((client) => {
    client.on('error', () => {});
    let stage = 'greet';
    let buffer = Buffer.alloc(0);

    const methods = user ? [0x00, 0x02] : [0x00];
    client.write(Buffer.from([0x05, methods.length, ...methods]));

    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);

      if (stage === 'greet' && buffer.length >= 2) {
        // The client answers the greeting with VER + METHOD (two bytes).
        const chosen = buffer[1];
        buffer = buffer.subarray(2);
        if (chosen === 0x02) {
          client.write(Buffer.from([0x05, 0x02]));
          stage = 'auth';
        } else {
          client.write(Buffer.from([0x05, 0x00]));
          stage = 'request';
        }
      }

      if (stage === 'auth' && buffer.length >= 2) {
        const userLen = buffer[1];
        if (buffer.length < 2 + userLen + 1) return;
        const passLen = buffer[2 + userLen];
        if (buffer.length < 3 + userLen + passLen) return;
        const gotUser = buffer.subarray(2, 2 + userLen).toString('utf8');
        const gotPass = buffer.subarray(3 + userLen, 3 + userLen + passLen).toString('utf8');
        buffer = buffer.subarray(3 + userLen + passLen);
        const ok = gotUser === user && gotPass === (password ?? '');
        client.write(Buffer.from([0x01, ok ? 0x00 : 0x01]));
        if (!ok) {
          client.end();
          return;
        }
        stage = 'request';
      }

      if (stage === 'request' && buffer.length >= 5) {
        const type = buffer[3];
        let host = null;
        let offset = 4;
        if (type === 0x01) {
          if (buffer.length < 10) return;
          host = Array.from(buffer.subarray(4, 8)).join('.');
          offset = 8;
        } else if (type === 0x03) {
          const len = buffer[4];
          if (buffer.length < 5 + len + 2) return;
          host = buffer.subarray(5, 5 + len).toString('utf8');
          offset = 5 + len;
        } else {
          client.end();
          return;
        }
        const port = buffer.readUInt16BE(offset);
        buffer = buffer.subarray(offset + 2);

        const upstream = net.connect(port, host, () => {
          client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 0]));
          client.removeAllListeners('data');
          if (buffer.length) upstream.write(buffer);
          client.pipe(upstream);
          upstream.pipe(client);
        });
        client.on('error', () => upstream.destroy());
        upstream.on('error', () => client.destroy());
        stage = 'relay';
      }
    };

    client.on('data', onData);
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}
