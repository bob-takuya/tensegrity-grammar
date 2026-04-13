import { AppProvider } from './state/context';
import { Viewer3D } from './components/Viewer3D';
import { ControlPanel } from './components/ControlPanel';
import { Inspector } from './components/Inspector';
import './App.css';

export default function App() {
  return (
    <AppProvider>
      <div className="app">
        <div className="toolbar">
          <div className="toolbar-group toolbar-title">
            <span className="app-title">Class-1 Tensegrity Search</span>
          </div>
        </div>
        <div className="main-content">
          <div className="sidebar sidebar-left">
            <ControlPanel />
          </div>
          <div className="viewer-area">
            <Viewer3D />
          </div>
          <div className="sidebar sidebar-right">
            <Inspector />
          </div>
        </div>
      </div>
    </AppProvider>
  );
}
