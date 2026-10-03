// Binarios estables servidos por Caddy desde /var/www/cfanalisis-downloads en
// el VPS (fuera del repo; el deploy web no los toca). El enlace Android se
// comparte entre el Home y el menú del dashboard. La IPA unsigned se distribuye
// por el enlace canónico para instalación con SideStore.
export const ANDROID_APK_URL = 'https://cfanalisis.com/android/cfanalisis.apk';
export const IOS_IPA_URL = 'https://cfanalisis.com/cfanalisis.ipa';
