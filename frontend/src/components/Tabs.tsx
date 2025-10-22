interface Tab {
  id: string;
  label: string;
}

interface TabsProps {
  tabs: Tab[];
  activeTab: string;
  onTabChange: (tabId: string) => void;
}

export function Tabs({ tabs, activeTab, onTabChange }: TabsProps) {
  return (
    <div style={{
      borderBottom: '2px solid #ddd',
      marginBottom: '20px',
      display: 'flex',
      gap: '0'
    }}>
      {tabs.map((tab) => (
        <button
          key={tab.id}
          onClick={() => onTabChange(tab.id)}
          style={{
            padding: '12px 20px',
            background: activeTab === tab.id ? '#007bff' : 'transparent',
            color: activeTab === tab.id ? 'white' : '#666',
            border: 'none',
            borderBottom: activeTab === tab.id ? '3px solid #0056b3' : 'none',
            cursor: 'pointer',
            fontSize: '14px',
            fontWeight: activeTab === tab.id ? 'bold' : 'normal',
            transition: 'all 0.3s ease'
          }}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}