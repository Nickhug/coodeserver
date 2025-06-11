declare module 'node-fetch' {
  import { RequestInfo, RequestInit, Response } from 'node-fetch';
  
  export default function fetch(
    url: RequestInfo,
    init?: RequestInit
  ): Promise<Response>;

  export type { RequestInfo, RequestInit, Response };
}
