'use client';

import { useEffect, useState } from 'react';
import { ITSSS_LOGO_SRC, ITSSS_LOGO_WIDTH, ITSSS_LOGO_HEIGHT } from '../lib/branding';
import './brand-logo.css';

type CompanyBrand = { name?: string; logo?: { url?: string }[]; [key: string]: unknown };

export default function BrandLogo({ company, className = '' }: {
  company?: CompanyBrand;
  className?: string;
}) {
  const url = company?.logo?.[0]?.url;
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [url]);
  const customLogo = failed ? undefined : url;

  return <span className={`brand-logo-surface ${className}`}>
    <img
      src={customLogo ? `${customLogo}${customLogo.includes('?') ? '&' : '?'}inline=1` : ITSSS_LOGO_SRC}
      width={ITSSS_LOGO_WIDTH}
      height={ITSSS_LOGO_HEIGHT}
      alt={customLogo ? `${company?.name || 'Company'} logo` : 'ITSSS logo'}
      onError={customLogo ? () => setFailed(true) : undefined}
    />
  </span>;
}
