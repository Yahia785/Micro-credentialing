//Configures React app before it starts
//connects React to AWS
import React from 'react';
import ReactDOM from 'react-dom/client';
import { Amplify } from 'aws-amplify';
// Removed amplify_outputs import - using environment variables instead
import App from './App';
import './index.css';

//Configure Amplify with environment variables
Amplify.configure({
  Auth: {
    Cognito: {
      userPoolId: import.meta.env.VITE_USER_POOL_ID,
      userPoolClientId: import.meta.env.VITE_APP_CLIENT_ID,
    }
  }
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);