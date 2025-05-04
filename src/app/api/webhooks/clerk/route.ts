import { WebhookEvent } from "@clerk/nextjs/server";
import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { Webhook } from "svix";
import { createUser, getUser } from "../../../../lib/supabase/client";

// This webhook will be called by Clerk when user events happen
export async function POST(req: Request) {
  // Get the headers
  const headersList = await headers(); // Await the headers promise
  const svix_id = headersList.get("svix-id");
  const svix_timestamp = headersList.get("svix-timestamp");
  const svix_signature = headersList.get("svix-signature");

  // If there are no headers, return error
  if (!svix_id || !svix_timestamp || !svix_signature) {
    return new Response("Error: Missing svix headers", {
      status: 400,
    });
  }

  // Get the body
  const payload = await req.json();
  const body = JSON.stringify(payload);

  // Create a new Svix instance with your webhook secret
  const wh = new Webhook(process.env.CLERK_WEBHOOK_SECRET || "");

  let evt: WebhookEvent;

  // Verify the payload with the headers
  try {
    evt = wh.verify(body, {
      "svix-id": svix_id,
      "svix-timestamp": svix_timestamp,
      "svix-signature": svix_signature,
    }) as WebhookEvent;
  } catch (err) {
    console.error("Error verifying webhook:", err);
    return new Response("Error verifying webhook", {
      status: 400,
    });
  }

  // Get the ID and type of the event
  const eventType = evt.type;

  // Handle user creation
  if (eventType === "user.created") {
    const { id, email_addresses } = evt.data;
    
    if (!id || !email_addresses || email_addresses.length === 0) {
      return new Response("Error: Invalid user data", {
        status: 400,
      });
    }
    
    const email = email_addresses[0].email_address;
    
    // Check if user already exists in database
    const existingUser = await getUser(id);
    
    if (!existingUser) {
      // Create user in our database
      try {
        await createUser(id, email);
      } catch (error) {
        console.error("Error creating user in database:", error);
        return new Response("Error creating user in database", {
          status: 500,
        });
      }
    }
  }

  // Return a 200 response
  return NextResponse.json({ success: true });
} 