import { fetchAuthSession, fetchUserAttributes } from 'aws-amplify/auth';

// Use proxy in development, direct API in production
const API_BASE = import.meta.env.DEV 
  ? '/api'  // Development: Use Vite proxy
  : import.meta.env.VITE_API_ENDPOINT;  // Production: Direct API call

/**
 * Get authentication token
 */
async function getAuthToken(): Promise<string> {
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
async function getCurrentUserAttributes() {
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

/**
 * Create user profile
 */
export async function createUserProfile(userData?: { email?: string; name?: string }) {
  const token = await getAuthToken();
  
  // If no userData provided, get from Cognito
  let profileData = userData;
  if (!profileData || !profileData.email) {
    profileData = await getCurrentUserAttributes();
  }

  console.log('Creating user with data:', profileData);

  const response = await fetch(`${API_BASE}/users`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify(profileData),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('Create user failed:', response.status, errorText);
    throw new Error(`HTTP error! status: ${response.status}`);
  }

  return response.json();
}

/**
 * Get current user profile
 */
export async function getUserProfile() {
  const token = await getAuthToken();

  console.log('Fetching user profile from:', `${API_BASE}/users/me`);

  const response = await fetch(`${API_BASE}/users/me`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('Get user failed:', response.status, errorText);
    throw new Error(`HTTP error! status: ${response.status}`);
  }

  return response.json();
}

/**
 * Update user profile
 */
export async function updateUserProfile(updates: { name?: string; email?: string }) {
  const token = await getAuthToken();

  console.log('Updating user profile with:', updates);

  const response = await fetch(`${API_BASE}/users/me`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify(updates),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('Update user failed:', response.status, errorText);
    throw new Error(`HTTP error! status: ${response.status}`);
  }

  return response.json();
}

export default {
  createUserProfile,
  getUserProfile,
  updateUserProfile,
};