import { fetchAuthSession, fetchUserAttributes } from 'aws-amplify/auth';

if (!import.meta.env.VITE_API_ENDPOINT) {
  throw new Error(
    'VITE_API_ENDPOINT is not set. Run Vite with the right mode (e.g. --mode dev) so its .env file is loaded.'
  );
}

export const API_BASE = import.meta.env.VITE_API_ENDPOINT;

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