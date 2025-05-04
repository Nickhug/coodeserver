# VVS - Void Server

Authentication, subscription management, and AI service proxy for Void Editor.

## Features

- Authentication via Clerk
- Database with Supabase
- Authentication between Void editor and server

## Getting Started

### Prerequisites

1. Node.js 18+ and npm
2. A Clerk account (for authentication)
3. A Supabase account (for database)

### Installation

1. Clone the repository
2. Install dependencies:

```bash
npm install
```

3. Create a `.env.local` file with the following environment variables:

```bash
# Clerk Authentication
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_your-key-here
CLERK_SECRET_KEY=sk_test_your-key-here
CLERK_WEBHOOK_SECRET=whsec_your-webhook-secret

# Supabase Database
NEXT_PUBLIC_SUPABASE_URL=https://your-project-id.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key

# App URL
NEXT_PUBLIC_APP_URL=http://localhost:3000
```

4. Run the development server:

```bash
npm run dev
```

5. Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

## Database Setup

In Supabase, create the following tables:

1. `users` table:
   - `id`: uuid, primary key, default: uuid_generate_v4()
   - `clerk_id`: text, not null
   - `email`: text, not null
   - `credits_remaining`: integer, not null, default: 100
   - `subscription_tier`: text, not null, default: 'free'
   - `created_at`: timestamptz, not null, default: now()
   - `updated_at`: timestamptz, not null, default: now()

2. `usage` table:
   - `id`: uuid, primary key, default: uuid_generate_v4() 
   - `user_id`: uuid, references users(id)
   - `provider`: text, not null
   - `model`: text, not null
   - `tokens_used`: integer, not null
   - `credits_used`: integer, not null
   - `created_at`: timestamptz, not null, default: now()

## Integrating with Void Editor

The Void editor communicates with this server for authentication using browser cookies. 
The auth flow works as follows:

1. User authenticates on the web server (using Clerk)
2. Server sets a `vvs_auth` cookie with user information
3. Void editor reads this cookie and verifies with the server
4. Void stores authentication status and checks periodically

## Project Structure

```
src/
├── app/                      # Next.js app router
│   ├── api/                  # API routes
│   │   ├── ai-providers/     # AI provider endpoints
│   │   ├── usage/            # Usage analytics
│   │   └── webhooks/         # Webhook handlers
│   └── ...                   # Other application routes
├── components/               # React components
├── lib/                      # Shared library code
│   ├── ai-providers/         # AI provider integrations
│   ├── clerk/                # Authentication utilities
│   ├── stripe/               # Subscription management
│   └── supabase/             # Database utilities
└── middleware.ts             # Authentication middleware
```

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
