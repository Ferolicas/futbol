'use client';

import { UpgradeButton, useFreeAccess } from './FreeAccessProvider';
import Link from 'next/link';
import BrandLogoMedia from '../../../components/BrandLogoMedia';
import ChatWidget from '../chat-widget';
import AppleSpotlightSearch from './AppleSpotlightSearch';

export default function DashboardHeader() {
  const { isFree } = useFreeAccess();
  return (
    <header className={`dashboard-topbar${isFree ? ' is-free' : ''}`}>
      <ChatWidget />

      <Link href="/dashboard" className="dashboard-brand" aria-label="Ir al dashboard">
        <BrandLogoMedia />
      </Link>

      <div className="dashboard-header-actions"><AppleSpotlightSearch /><UpgradeButton /></div>
    </header>
  );
}
