import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata={title:'AgentBond — Agents can hire.', description:'Bounded work. Independent verification. Real Solana settlement.'};
export default function RootLayout({children}:{children:React.ReactNode}){return <html lang="en"><body>{children}</body></html>}
