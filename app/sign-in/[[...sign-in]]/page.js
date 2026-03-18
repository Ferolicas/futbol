import { SignIn } from '@clerk/nextjs';

export default function SignInPage() {
  return (
    <div className="login-page">
      <div className="login-bg" />
      <div className="login-container" style={{ maxWidth: '420px' }}>
        <SignIn
          forceRedirectUrl="/dashboard"
          signUpUrl="/sign-up"
        />
        <div style={{ textAlign: 'center', marginTop: '16px' }}>
          <a href="/" className="login-link">Volver al inicio</a>
        </div>
      </div>
    </div>
  );
}
