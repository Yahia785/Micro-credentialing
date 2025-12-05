import { useEffect, useState } from 'react';
import { getUserCredentials, type Credential } from '../api/credentials';

export function CredentialsTab() {
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function loadCredentials() {
      try {
        setLoading(true);
        setError(null);
        const response = await getUserCredentials();
        setCredentials(response.credentials || []);
      } catch (err: any) {
        console.error('Error loading credentials:', err);
        setError(err.message || 'Failed to load credentials');
      } finally {
        setLoading(false);
      }
    }

    loadCredentials();
  }, []);

  if (loading) {
    return (
      <div style={{ padding: '20px' }}>
        <h3 style={{ color: '#333', marginBottom: '15px' }}>My Credentials</h3>
        <p style={{ color: '#666' }}>Loading your credentials...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ padding: '20px' }}>
        <h3 style={{ color: '#333', marginBottom: '15px' }}>My Credentials</h3>
        <div style={{
          padding: '15px',
          background: '#ffe6e6',
          borderRadius: '4px',
          color: '#d63031'
        }}>
          <strong>Error:</strong> {error}
        </div>
      </div>
    );
  }

  if (credentials.length === 0) {
    return (
      <div style={{ padding: '20px' }}>
        <h3 style={{ color: '#333', marginBottom: '15px' }}>My Credentials</h3>
        <div style={{
          padding: '20px',
          background: '#f9f9f9',
          borderRadius: '8px',
          border: '1px solid #ddd',
          textAlign: 'center'
        }}>
          <p style={{ color: '#666', fontSize: '16px', marginBottom: '10px' }}>
            🎓 No credentials yet
          </p>
          <p style={{ color: '#999', fontSize: '14px' }}>
            Complete coding problems and pass proctoring review to earn credentials
          </p>
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding: '20px' }}>
      <h3 style={{ color: '#333', marginBottom: '20px', fontSize: '24px' }}>
        My Credentials
      </h3>
      
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(350px, 1fr))',
        gap: '20px'
      }}>
        {credentials.map((credential) => (
          <div
            key={credential.credentialId}
            style={{
              background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
              borderRadius: '12px',
              padding: '20px',
              boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
              color: 'white',
              position: 'relative',
              overflow: 'hidden'
            }}
          >
            {/* Decorative background pattern */}
            <div style={{
              position: 'absolute',
              top: 0,
              right: 0,
              fontSize: '120px',
              opacity: 0.1,
              lineHeight: 1,
              pointerEvents: 'none'
            }}>
              🎓
            </div>

            {/* Content */}
            <div style={{ position: 'relative', zIndex: 1 }}>
              {/* Problem Title */}
              <h4 style={{
                margin: '0 0 10px 0',
                fontSize: '20px',
                fontWeight: 'bold',
                color: 'white'
              }}>
                {credential.problemTitle}
              </h4>

              {/* Score Badge */}
              <div style={{
                display: 'inline-block',
                background: 'rgba(255,255,255,0.2)',
                padding: '4px 12px',
                borderRadius: '20px',
                fontSize: '14px',
                fontWeight: 'bold',
                marginBottom: '15px'
              }}>
                Score: {credential.score}%
              </div>

              {/* Recipient Info */}
              <div style={{
                fontSize: '14px',
                opacity: 0.9,
                marginBottom: '15px'
              }}>
                <p style={{ margin: '5px 0' }}>
                  <strong>Recipient:</strong> {credential.recipientName}
                </p>
                <p style={{ margin: '5px 0' }}>
                  <strong>Issued:</strong> {new Date(credential.issuedAt).toLocaleDateString()}
                </p>
              </div>

              {/* Certificate Actions */}
              <div style={{
                display: 'flex',
                gap: '10px',
                marginTop: '20px'
              }}>
                <a
                  href={credential.bcdiplomaUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    flex: 1,
                    padding: '12px 20px',
                    background: 'white',
                    color: '#667eea',
                    textDecoration: 'none',
                    borderRadius: '6px',
                    fontWeight: 'bold',
                    textAlign: 'center',
                    transition: 'transform 0.2s, box-shadow 0.2s',
                    boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: '8px'
                  }}
                  onMouseOver={(e) => {
                    e.currentTarget.style.transform = 'translateY(-2px)';
                    e.currentTarget.style.boxShadow = '0 4px 12px rgba(0,0,0,0.3)';
                  }}
                  onMouseOut={(e) => {
                    e.currentTarget.style.transform = 'translateY(0)';
                    e.currentTarget.style.boxShadow = '0 2px 8px rgba(0,0,0,0.2)';
                  }}
                >
                  <span>🔗</span>
                  View Certificate
                </a>
              </div>

              {/* Copy Link Button */}
              <button
                onClick={() => {
                  navigator.clipboard.writeText(credential.bcdiplomaUrl);
                  
                  const button = document.getElementById(`copy-${credential.credentialId}`);
                  if (button) {
                    const originalText = button.textContent;
                    button.textContent = '✓ Copied!';
                    setTimeout(() => {
                      button.textContent = originalText || '';
                    }, 2000);
                  }
                }}
                id={`copy-${credential.credentialId}`}
                style={{
                  width: '100%',
                  marginTop: '10px',
                  padding: '8px',
                  background: 'rgba(255,255,255,0.15)',
                  color: 'white',
                  border: '1px solid rgba(255,255,255,0.3)',
                  borderRadius: '4px',
                  fontSize: '12px',
                  cursor: 'pointer',
                  transition: 'background 0.2s'
                }}
                onMouseOver={(e) => {
                  e.currentTarget.style.background = 'rgba(255,255,255,0.25)';
                }}
                onMouseOut={(e) => {
                  e.currentTarget.style.background = 'rgba(255,255,255,0.15)';
                }}
              >
                📋 Copy Certificate Link
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* Summary Stats */}
      <div style={{
        marginTop: '30px',
        padding: '20px',
        background: '#f9f9f9',
        borderRadius: '8px',
        border: '1px solid #ddd'
      }}>
        <h4 style={{ color: '#333', marginTop: 0, marginBottom: '15px' }}>
          📊 Summary
        </h4>
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
          gap: '15px'
        }}>
          <div>
            <div style={{ fontSize: '14px', color: '#666', marginBottom: '5px' }}>
              Total Credentials
            </div>
            <div style={{ fontSize: '24px', fontWeight: 'bold', color: '#667eea' }}>
              {credentials.length}
            </div>
          </div>
          <div>
            <div style={{ fontSize: '14px', color: '#666', marginBottom: '5px' }}>
              Latest Credential
            </div>
            <div style={{ fontSize: '16px', fontWeight: 'bold', color: '#333' }}>
              {new Date(
                Math.max(...credentials.map(c => new Date(c.issuedAt).getTime()))
              ).toLocaleDateString()}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
