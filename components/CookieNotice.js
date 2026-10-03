'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

const STORAGE_KEY = 'cf:essential-cookie-notice:2026-10-03';

export default function CookieNotice() {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    setVisible(localStorage.getItem(STORAGE_KEY) !== 'seen');
  }, []);
  if (!visible) return null;
  return (
    <aside className="cookie-notice" aria-label="Aviso de cookies">
      <p>
        Usamos únicamente la cookie esencial de sesión y almacenamiento técnico necesario.
        No usamos cookies publicitarias. <Link href="/cookies">Más información</Link>
      </p>
      <button type="button" onClick={() => {
        localStorage.setItem(STORAGE_KEY, 'seen');
        setVisible(false);
      }}>Entendido</button>
    </aside>
  );
}
