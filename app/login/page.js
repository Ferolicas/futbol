import { redirect } from 'next/navigation';

// Legacy login page — redirect to Clerk sign-in
export default function LoginPage() {
  redirect('/sign-in');
}
