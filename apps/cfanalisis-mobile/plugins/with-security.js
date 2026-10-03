const { withAndroidManifest } = require('@expo/config-plugins');

module.exports = function withSecurity(config) {
  return withAndroidManifest(config, (result) => {
    const application = result.modResults.manifest.application?.[0];
    if (!application) throw new Error('AndroidManifest no contiene application');
    application.$ = application.$ || {};
    application.$['android:allowBackup'] = 'false';
    application.$['android:usesCleartextTraffic'] = 'false';
    return result;
  });
};
