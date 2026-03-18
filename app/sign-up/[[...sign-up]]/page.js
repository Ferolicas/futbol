import { SignUp } from '@clerk/nextjs';

export default function SignUpPage() {
  return (
    <div className="login-page">
      <div className="login-bg" />
      <div className="login-container" style={{ maxWidth: '420px' }}>
        <SignUp
          forceRedirectUrl="/planes"
          signInUrl="/sign-in"
        />
        <div style={{ textAlign: 'center', marginTop: '16px' }}>
          <a href="/" className="login-link">Volver al inicio</a>
        </div>
      </div>
    </div>
  );
}
