'use client';

import Link from 'next/link';
import BrandLogoMedia from '../../../components/BrandLogoMedia';
import AppleSpotlightSearch from './AppleSpotlightSearch';

export default function DashboardHeader() {
  return (
    <header className="dashboard-topbar">
      <Link href="/dashboard" className="dashboard-brand" aria-label="Ir al dashboard">
        <BrandLogoMedia />
      </Link>

      <AppleSpotlightSearch />
    </header>
  );
}
