import { AppProvider } from './state/context';
import { Viewer3D } from './components/Viewer3D';
import { ControlPanel } from './components/ControlPanel';
import './App.css';

export default function App() {
  return (
    <AppProvider>
      <div className="app">
        <div className="toolbar">
          <div className="toolbar-group toolbar-title">
            <span className="app-title">Tensegrity Morphogenesis</span>
          </div>
        </div>
        <div className="main-content">
          <div className="viewer-area">
            <Viewer3D />
          </div>
          <div className="sidebar">
            <ControlPanel />
          </div>
        </div>
      </div>
    </AppProvider>
  );
}
