import { NextRequest, NextResponse } from 'next/server';
import httpProxy from 'http-proxy';
import http from 'http'; // Required for type checking proxy.web

// Ensure this is set in your environment variables on Railway
// Example: ws://ws-server.railway.internal:3001 or http://ws-server.railway.internal:3001
// Using http:// might be more common for the initial target, http-proxy handles the upgrade to ws.
const targetUrl = process.env.INTERNAL_WS_URL;

if (!targetUrl) {
  const errorMessage = "FATAL: INTERNAL_WS_URL environment variable is not set for WebSocket proxy.";
  console.error(errorMessage);
  // This error should ideally prevent the application from running or this route from being effective.
  // For now, we'll log it. In a production system, you might throw an error during startup.
}

const proxy = httpProxy.createProxyServer({
  target: targetUrl,    // Target internal WebSocket server
  ws: true,             // Enable WebSocket proxying
  changeOrigin: true,   // Recommended: Changes the origin of the host header to the target URL
  secure: false,        // Set to true if your internal WS server uses SSL with valid certs (unlikely for internal Railway)
});

console.log(`[WS Proxy] Initialized for target: ${targetUrl}`);

proxy.on('error', (err, req, res) => {
  console.error('[WS Proxy] Error:', err);
  // res can be an http.ServerResponse or a net.Socket
  if (res instanceof http.ServerResponse) {
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/plain' }); // 502 Bad Gateway
    }
    res.end('WebSocket proxy error: Could not connect to upstream server.');
  } else if (res && typeof (res as any).destroy === 'function') {
    console.log('[WS Proxy] Destroying socket due to error.');
    (res as any).destroy();
  }
});

proxy.on('proxyReqWs', (proxyReq, req, socket, options, head) => {
  console.log(`[WS Proxy] Upgrading request to WebSocket: ${req.method} ${req.url}`);
  // Example: You can add custom headers to the WebSocket handshake request to the target here
  // proxyReq.setHeader('X-Forwarded-Proto', 'wss');
});

proxy.on('open', (proxySocket) => {
  console.log('[WS Proxy] WebSocket connection opened to target.');
});

proxy.on('close', (proxyRes, proxySocket, proxyHead) => {
  console.log('[WS Proxy] WebSocket connection closed.');
});

export async function GET(req: NextRequest) {
  console.log(`[WS Route] Incoming request: ${req.method} ${req.url}`);

  if (!targetUrl) {
    console.error("[WS Route] Target URL for WebSocket proxy is not configured. Aborting.");
    return NextResponse.json({ error: "Proxy target not configured" }, { status: 500 });
  }
  
  // Check if it's a WebSocket upgrade request
  if (req.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
    console.log('[WS Route] Not a WebSocket upgrade request. Responding with 426.');
    return NextResponse.json(
      { message: 'This endpoint is intended for WebSocket connections. Please use a WebSocket client.' },
      { status: 426 } // 426 Upgrade Required
    );
  }

  console.log('[WS Route] WebSocket upgrade request detected. Attempting to proxy...');

  // To use http-proxy with Next.js App Router, we need to prevent Next.js
  // from handling the response directly and instead let http-proxy take over.
  // This is done by returning a special kind of response or by not returning
  // a standard NextResponse, allowing the connection to be "hijacked".

  // The `req` object for `proxy.web` needs to be a Node.js IncomingMessage.
  // The `res` object needs to be a Node.js ServerResponse.
  // Next.js `NextRequest` is based on the Fetch API.
  // Accessing the raw Node.js objects can be tricky and adapter-dependent.
  
  // This is a common pattern: returning a response that signals Next.js to release control.
  // The actual proxying of the WebSocket connection is handled by `http-proxy`
  // because `ws: true` is set. The initial HTTP GET request is passed to `proxy.web`.
  // If this initial request contains the upgrade headers, `http-proxy` handles the switch.

  // IMPORTANT: This relies on the underlying server (Node.js adapter for Vercel/Railway)
  // correctly exposing the necessary raw request/response objects or allowing socket hijacking
  // in a way that `http-proxy` can work with.

  // We create a promise that will be resolved when the proxying is done,
  // or rejected if an error occurs.
  return new Promise((resolve, reject) => {
    // We need to adapt NextRequest to what http-proxy expects (Node's IncomingMessage).
    // This adaptation is non-trivial. A common approach is to hope the server adapter
    // makes the original Node request available.
    // For this example, we assume `req` can be cast or directly used if the adapter populates it.
    // This is a significant simplification and might need adjustment.
    
    // A more robust way to get underlying req/res is needed for production.
    // If `req.originalRequest` or similar isn't available or suitable, this will fail.
    // For now, we pass `req` and a placeholder `res` and rely on `http-proxy`'s magic.

    // This is a placeholder for where you'd get the raw Node.js response object.
    // In a typical Next.js API route (especially app router), this is not straightforward.
    const mockRes = {
        writableEnded: false,
        setHeader: () => {},
        writeHead: (status: number) => { console.log(`[WS Proxy] MockRes writeHead: ${status}`); },
        end: (cb?: () => void) => { console.log("[WS Proxy] MockRes end called."); if(cb) cb(); resolve(new Response(null, { status: 101 })); },
        socket: null, // http-proxy needs a socket on res for .ws() but not always for .web() + ws:true
    } as unknown as http.ServerResponse;


    // Attempt to proxy the web request. If it's an upgrade, http-proxy should handle it.
    // @ts-ignore - `req` is NextRequest, `proxy.web` expects http.IncomingMessage.
    // This is a known difficulty. Some adapters might make the Node req available on NextRequest.
    proxy.web(req as any, mockRes, { target: targetUrl, ws: true }, (err) => {
        if (err) {
            console.error('[WS Route] Error from proxy.web callback:', err);
            // Do not resolve with NextResponse here as headers might have been sent
            // or the socket might be in an indeterminate state.
            // The 'error' event on the proxy should handle logging and cleanup.
            // We resolve the promise to signal completion, but the actual error handling
            // for the client connection happens via the proxy's error event listener.
            resolve(NextResponse.json({ error: "WebSocket proxy failed" }, { status: 502 }));
        }
        // If successful (e.g., 101 Switching Protocols), the connection is now a WebSocket.
        // The promise resolves, but Next.js should not send further HTTP responses.
        // The `mockRes.end()` call inside the mockRes would resolve this promise.
        console.log('[WS Route] proxy.web call completed for WebSocket upgrade.');
    });

    // IMPORTANT: By returning a Promise that resolves (e.g. via mockRes.end),
    // we are fulfilling Next.js's expectation of a response.
    // The actual WebSocket connection is managed by http-proxy outside this flow.
  });
}

// Configuration for the API route
export const runtime = 'nodejs';    // Essential: http-proxy requires Node.js runtime
export const dynamic = 'force-dynamic'; // Opt-out of caching, ensures dynamic handling

// If this were in `pages/api`, you'd use:
// export const config = {
//   api: {
//     bodyParser: false,        // Let the proxy handle the request body
//     externalResolver: true,   // Crucial: tells Next.js you're handling the response
//   },
// };
// For App Router, not returning a NextResponse achieves a similar effect for hijacking. 