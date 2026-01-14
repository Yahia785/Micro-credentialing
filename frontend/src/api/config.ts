import { fetchAuthSession, fetchUserAttributes } from 'aws-amplify/auth';

// ONLY use proxy on actual localhost, never on deployed environments
const isLocalhost = typeof window !== 'undefined' && 
  (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');

// Use proxy ONLY on localhost, direct API everywhere else (including Amplify dev deployments)
export const API_BASE = isLocalhost
  ? '/api'  // Localhost only: Use Vite proxy
  : import.meta.env.VITE_API_ENDPOINT;  // Amplify/Production: Direct API call

console.log('🔧 API Configuration:', {
  isLocalhost,
  hostname: typeof window !== 'undefined' ? window.location.hostname : 'server',
  API_BASE,
  VITE_API_ENDPOINT: import.meta.env.VITE_API_ENDPOINT
});

/**
 * Get authentication token
 */
export async function getAuthToken(): Promise<string> {
  try {
    const session = await fetchAuthSession();
    const token = session.tokens?.idToken?.toString();
    if (!token) {
      throw new Error('No authentication token available');
    }
    return token;
  } catch (error) {
    console.error('Error getting auth token:', error);
    throw error;
  }
}

/**
 * Get current user attributes from Cognito
 */
export async function getCurrentUserAttributes() {
  try {
    const attributes = await fetchUserAttributes();
    return {
      email: attributes.email || '',
      name: attributes.name || attributes.email?.split('@')[0] || 'User'
    };
  } catch (error) {
    console.error('Error fetching user attributes:', error);
    throw error;
  }
}