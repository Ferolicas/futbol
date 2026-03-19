import './globals.css';
import { ClerkProvider } from '@clerk/nextjs';
import { esES as esESBase } from '@clerk/localizations';

const esES = {
  ...esESBase,
  formFieldHintText__password: 'Tu contraseña cumple con todos los requisitos.',
  unstable__errors: {
    ...esESBase.unstable__errors,
    form_password_meets_requirements: 'Tu contraseña cumple con todos los requisitos.',
  },
};

export const metadata = {
  title: 'Analisis Deportivos - CF Analisis',
  description: 'Plataforma avanzada de analisis de futbol y apuestas deportivas. Estadisticas, combinadas inteligentes, marcadores en vivo.',
  keywords: 'futbol, apuestas, analisis, estadisticas, combinadas, probabilidades',
  icons: {
    icon: '/vflogo.png',
    apple: '/vflogo.png',
  },
};

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
};

const clerkAppearance = {
  layout: {
    logoImageUrl: '/vflogo.png',
    logoPlacement: 'inside',
  },
  variables: {
    colorPrimary: '#00e676',
    colorBackground: '#0c0c14',
    colorText: '#ffffff',
    colorTextSecondary: 'rgba(255,255,255,0.55)',
    colorInputBackground: 'rgba(0,230,118,0.04)',
    colorInputText: '#ffffff',
    borderRadius: '12px',
  },
  elements: {
    card: {
      background: 'linear-gradient(180deg, #06060b 0%, #0c0c14 40%, #0f1018 100%)',
      border: '1px solid rgba(0,230,118,0.12)',
      borderRadius: '20px',
      boxShadow: '0 0 60px rgba(0,230,118,0.08), 0 12px 48px rgba(0,0,0,0.5)',
    },
    headerTitle: {
      color: '#fff',
      fontSize: '1.15rem',
    },
    headerSubtitle: {
      color: 'rgba(255,255,255,0.45)',
      fontSize: '0.82rem',
    },
    formFieldLabel: {
      color: 'rgba(255,255,255,0.7)',
      fontSize: '0.8rem',
    },
    formFieldHintText: {
      color: 'rgba(255,255,255,0.35)',
    },
    formFieldInput: {
      background: 'rgba(0,230,118,0.04)',
      border: '1px solid rgba(0,230,118,0.15)',
      color: '#fff',
      borderRadius: '10px',
      fontSize: '0.9rem',
    },
    formButtonPrimary: {
      background: 'linear-gradient(135deg, #00e676, #00b0ff)',
      color: '#000',
      fontWeight: 700,
      borderRadius: '12px',
      fontSize: '0.9rem',
    },
    socialButtonsIconButton: {
      background: 'rgba(0,230,118,0.06)',
      border: '1px solid rgba(0,230,118,0.25)',
      borderRadius: '10px',
    },
    dividerLine: { background: 'rgba(0,230,118,0.1)' },
    dividerText: { color: 'rgba(255,255,255,0.3)' },
    footerActionLink: { color: '#00e676' },
    footerActionText: { color: 'rgba(255,255,255,0.4)', fontSize: '0.82rem' },
    footer: {
      background: '#0c0c14',
      borderTop: '1px solid rgba(0,230,118,0.08)',
    },
    formFieldInputShowPasswordButton: { color: 'rgba(0,230,118,0.5)' },
    identityPreviewEditButton: { color: '#00e676' },
    formResendCodeLink: { color: '#00e676' },
    otpCodeFieldInput: {
      background: 'rgba(0,230,118,0.04)',
      border: '1px solid rgba(0,230,118,0.15)',
      color: '#fff',
    },
    alertText: { color: 'rgba(255,255,255,0.7)' },
    modalBackdrop: {
      backgroundColor: 'rgba(6, 6, 11, 0.85)',
      backdropFilter: 'blur(8px)',
    },
    modalCloseButton: {
      color: 'rgba(0,230,118,0.5)',
    },
  },
};

export default function RootLayout({ children }) {
  return (
    <html lang="es">
      <body>
        <ClerkProvider
          localization={esES}
          appearance={clerkAppearance}
          signUpForceRedirectUrl="/planes"
          signInForceRedirectUrl="/dashboard"
        >
          {children}
        </ClerkProvider>
      </body>
    </html>
  );
}
