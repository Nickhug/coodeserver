# VibeVVS Monorepo

This monorepo contains all components of the VibeVVS platform.

## Projects

The monorepo includes the following projects:

- `apps/web`: Next.js web application (frontend)
- `apps/ws-server`: WebSocket server for real-time communication
- `packages/auth`: Authentication utilities and middleware
- `packages/db`: Database clients and utilities
- `packages/logger`: Shared logging functionality
- `packages/types`: Shared TypeScript types
- `packages/ai-providers`: AI provider integrations
- `packages/ai`: AI-related utilities and functions
- `packages/utils`: Shared utility functions
- `packages/config`: Shared configuration and constants
- `packages/config/ai`: AI-related configuration
    - `packages/config/ws`: WebSocket-related configuration

## Development

### Prerequisites

- Node.js 18+
- npm 9+

### Setup

1. Clone the repository
2. Install dependencies:

```bash
npm install
```

3. Set up environment variables by creating `.env.local` files in the appropriate app directories

4. Run the development servers:

```bash
# Run all services in development mode
npm run dev

# Run only specific services
npm run dev --filter=web
npm run dev --filter=ws-server
```

## Deployment with Docker

The project can be deployed using Docker with the provided Dockerfile and docker-compose.yml.

### Prerequisites

- Docker
- Docker Compose

### Environment Variables

Create a `.env` file in the project root with the following variables:

```
CLERK_SECRET_KEY=your_clerk_secret_key
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=your_clerk_publishable_key
SUPABASE_URL=your_supabase_url
SUPABASE_SERVICE_KEY=your_supabase_service_key
GEMINI_API_KEY=your_gemini_api_key
OPENAI_API_KEY=your_openai_api_key
GROQ_API_KEY=your_groq_api_key
MISTRAL_API_KEY=your_mistral_api_key
```

### Building and Running

```bash
# Build and start all services
docker-compose up --build

# Build and start in detached mode
docker-compose up --build -d

# Build and start only specific services
docker-compose up --build web
docker-compose up --build ws-server

# Stop all services
docker-compose down
```

### Accessing the Services

- Web application: http://localhost:3000
- WebSocket server: ws://localhost:8080/ws

## Architecture

The VibeVVS platform follows a modular architecture:

1. **Frontend (Next.js)**: Serves the UI and handles user interactions
2. **WebSocket Server**: Manages real-time communication and LLM requests
3. **Shared Packages**: Provide reusable functionality across services
4. **AI Providers**: Integrate with various AI models for LLM capabilities

## Key Features
- Real-time chat with AI models
- Multi-user support
- Secure authentication using Clerk
- Extensible AI provider integration
- Scalable WebSocket server architecture

### Authentication Flow

1. User logs in via the web app using Clerk
2. Authentication token is generated and passed to WebSocket server
3. WebSocket server verifies the token and establishes an authenticated connection

### AI Provider Integrations

The platform supports multiple AI providers through the `@repo/ai-providers` package:

- Google Gemini
- OpenAI
-
- 

## Contributing

Please see the [CONTRIBUTING.md](./CONTRIBUTING.md) file for contribution guidelines. Please read the contributing guide before making a pull request. Thank you!

## License

This project is licensed under the MIT License - see the [LICENSE](./LICENSE) file for details.

## Acknowledgments

- [Clerk](https://clerk.dev/) for authentication
- [Next.js](https://nextjs.org/) for the web framework
- [React](https://reactjs.org/) for the UI library
- [WebSocket](https://developer.mozilla.org/en-US/docs/Web/API/WebSockets_API) for real-time communication

## Contact

For any inquiries, please contact [your-email@example.com](mailto:your-email@example.com).

## Roadmap

- [ ] Add more features
- [ ] Improve performance
- [ ] Add tests

## Contributors

- [Your Name](https://github.com/your-username) - Initial work

## Changelog

- [CHANGELOG.md](./CHANGELOG.md)

## License

This project is licensed under the [MIT License](./LICENSE).

---

This README.md file was generated with ❤️ by [Your Name](https://github.com/your-username).

magistral is the best