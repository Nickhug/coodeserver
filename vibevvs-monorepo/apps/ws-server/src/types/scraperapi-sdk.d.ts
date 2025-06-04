declare module 'scraperapi-sdk' {
  function createClient(apiKey: string): {
    get: (url: string, options?: any) => Promise<string>;
    post: (url: string, options?: any) => Promise<string>;
    put: (url: string, options?: any) => Promise<string>;
    delete: (url: string, options?: any) => Promise<string>;
    head: (url: string, options?: any) => Promise<string>;
    options: (url: string, options?: any) => Promise<string>;
  };
}
