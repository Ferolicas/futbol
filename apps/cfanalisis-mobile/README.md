# CF Análisis — app móvil nativa (React Native + Expo)

App nativa iOS/Android **separada** de la web. No modifica el Next.js de la raíz:
consume exactamente la misma API (`https://cfanalisis.com/api/*`), el mismo
WebSocket realtime (`wss://worker.cfanalisis.com/ws`) y, por tanto, la misma
base de datos PostgreSQL. Sin WebView.

## Cómo se conecta al backend existente

| Web | Móvil |
|---|---|
| Cookie httpOnly `cf_session` (JWT) | El mismo JWT se captura del `Set-Cookie` de `/api/auth/login` o `/api/register`, se guarda en SecureStore y viaja como cabecera `Cookie` en cada petición (`src/lib/api.ts`). |
| `/api/auth/session`, `/api/auth/logout` | Idénticos (`src/lib/auth-context.tsx`). |
| `/api/realtime/token` + subprotocolo `cfjwt.<token>` | Idéntico (`src/lib/realtime/socket.ts`). |
| Free vs Pro decidido en servidor | `POST /api/free/visit` devuelve `paid`/`showPlans`; la app nunca decide el acceso (`src/lib/access-context.tsx`). |
| Stripe PaymentElement | `POST /api/checkout` → `clientSecret` → PaymentSheet nativo de Stripe. |
| Mercado Pago (Colombia) | El Brick es web: se abre `cfanalisis.com/planes` en el navegador del sistema. |

Las reglas de producto que viven en librerías puras de la web (liquidación de
mercados, política de recomendaciones, Apuesta del día, etiquetas de mercado,
filtro de ligas…) están copiadas tal cual en `src/shared/` desde `lib/` y
`app/dashboard/utils/` del repo. Si cambian en la web, vuelve a copiarlas.

## Pantallas

- Login, registro y recuperación de contraseña.
- Dashboard único de cuatro deportes: tira de jornadas, filtro de ligas
  (persistido en `/api/user/leagues` para fútbol), Apuesta del día, tarjetas con
  marcador en vivo, dock inferior (Hoy/Próximos/En vivo/Finalizados/Favoritos)
  y constructor de combinadas (guardadas en `/api/user` para fútbol).
- Partido desplegado a pantalla completa con Mercados, Estadísticas,
  Frecuencias, Jugadores y Veredicto final; acceso Gratis con opción 60–70%.
- Análisis completo por deporte, buscador Spotlight, chat/soporte y tickets,
  planes y estado del pago.

## Puesta en marcha

```bash
cd apps/cfanalisis-mobile
cp .env.example .env            # rellena EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY
npm install
npm run typecheck
npx expo run:android            # o npx expo run:ios (requiere Xcode)
```

La app usa módulos nativos (Stripe, SecureStore, SVG), así que necesita un
**development build** (`expo run:*` o EAS Build); no funciona en Expo Go.

Producción: `eas build --platform all` con `EXPO_PUBLIC_*` definidas en el
perfil de EAS. Nunca pongas secretos de servidor (`WORKER_SECRET`,
`AUTH_JWT_SECRET`, claves privadas) en la app.

## Pendiente de backend (no incluido para no tocar la web)

- Notificaciones push nativas: la web usa Web Push (VAPID). Un endpoint que
  acepte tokens de Expo/APNs/FCM permitiría avisos de goles en móvil.
- Restablecer contraseña abre el enlace del email en la web; el nuevo password
  vale igual para la app.
