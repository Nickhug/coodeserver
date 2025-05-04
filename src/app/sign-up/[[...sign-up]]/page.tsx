import { SignUp } from "@clerk/nextjs";

export default function Page() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center p-4 bg-gray-50">
      <div className="w-full max-w-md space-y-8">
        <div className="text-center">
          <h1 className="text-4xl font-bold tracking-tight text-gray-900">
            Create your VVS Account
          </h1>
          <p className="mt-2 text-gray-600">
            Join to access AI features and settings
          </p>
        </div>
        
        <div className="mt-8 bg-white p-8 shadow rounded-lg">
          <SignUp 
            appearance={{
              elements: {
                formButtonPrimary: "bg-blue-600 hover:bg-blue-700",
                headerTitle: "hidden",
                headerSubtitle: "hidden",
                footerAction: "text-blue-600",
                card: "shadow-none"
              }
            }}
          />
        </div>
      </div>
    </div>
  );
} 