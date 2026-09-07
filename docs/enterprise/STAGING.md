# Staging privado

Staging escucha solo en `127.0.0.1:3100`, usa `cfanalisis_staging` y Redis DB
15, y no contiene claves de Stripe, Mercado Pago, email ni proveedores
deportivos. No se copian usuarios ni datos personales de producción.

Acceso desde una estación autorizada:

```bash
ssh -L 3100:127.0.0.1:3100 vps
```

Después se abre `http://127.0.0.1:3100`. El realtime LIVE se desactiva en el
bundle cuando el hostname no es `cfanalisis.com`; por eso staging no puede
emitir ni consumir eventos de producción.

`scripts/vps/deploy-staging.sh` reutiliza con hardlinks el runtime de producción
ya validado, sustituye su `.env` y arranca un único proceso PM2. DAST y k6
entran por un túnel SSH de GitHub Actions con host key fijada.

Para probar pagos se requieren credenciales sandbox independientes. Nunca se
deben copiar las credenciales LIVE al staging.
