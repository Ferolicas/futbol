import ChatWidget from './chat-widget';

export const metadata = {
  title: 'Dashboard - CFanalisis',
};

export default function DashboardLayout({ children }) {
  return (
    <>
      {children}
      <ChatWidget />
    </>
  );
}
