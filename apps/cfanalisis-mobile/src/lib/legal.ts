import { Linking } from 'react-native';

export const LEGAL_DOCUMENT_VERSION = '2026-10-03';

export const LEGAL_DOCUMENTS = [
  { key: 'terminos', label: 'Términos y condiciones', url: 'https://cfanalisis.com/terminos' },
  { key: 'privacidad', label: 'Política de privacidad', url: 'https://cfanalisis.com/privacidad' },
  { key: 'cookies', label: 'Política de cookies', url: 'https://cfanalisis.com/cookies' },
] as const;

export function openLegalDocument(url: string) {
  if (!LEGAL_DOCUMENTS.some((document) => document.url === url)) {
    throw new Error('Documento legal no permitido');
  }
  return Linking.openURL(url);
}
