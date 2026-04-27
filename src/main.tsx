import React from 'react';
import ReactDOM from 'react-dom/client';
import 'maplibre-gl/dist/maplibre-gl.css';
import './styles.css';
import { App } from './App';

class AppErrorBoundary extends React.Component<
  React.PropsWithChildren,
  { hasError: boolean; message: string }
> {
  constructor(props: React.PropsWithChildren) {
    super(props);
    this.state = {
      hasError: false,
      message: ''
    };
  }

  static getDerivedStateFromError(error: unknown) {
    return {
      hasError: true,
      message: error instanceof Error ? error.message : 'The interface failed to start.'
    };
  }

  componentDidCatch(error: unknown) {
    console.error('Kerbodyne app crashed during render:', error);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="app-fallback">
          <span className="section-title">Ground station unavailable</span>
          <strong>{this.state.message}</strong>
        </div>
      );
    }

    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <AppErrorBoundary>
    <App />
  </AppErrorBoundary>
);
