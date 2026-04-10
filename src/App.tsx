import { AppProvider } from './state/context';
import { Toolbar } from './components/Toolbar';
import { FormCanvas } from './components/FormCanvas';
import { ForceCanvas } from './components/ForceCanvas';
import { PropertiesPanel } from './components/PropertiesPanel';
import { GrammarPanel } from './components/GrammarPanel';
import { HistoryPanel } from './components/HistoryPanel';
import './App.css';

export default function App() {
  return (
    <AppProvider>
      <div className="app">
        <Toolbar />
        <div className="main-content">
          <div className="canvases">
            <FormCanvas />
            <ForceCanvas />
          </div>
          <div className="sidebar">
            <PropertiesPanel />
            <GrammarPanel />
            <HistoryPanel />
          </div>
        </div>
      </div>
    </AppProvider>
  );
}
