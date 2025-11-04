import { useState, useEffect } from 'react';
import { getAllMilestones, createMilestone, deleteMilestone } from '../api/milestones';
import { CodeEditor } from './CodeEditor';

interface Problem {
  milestoneId: string;
  title: string;
  description: string;
  difficulty: 'easy' | 'medium' | 'hard';
  language?: string;
  starterCode?: string;
  timeLimit?: number;
  memoryLimit?: number;
  createdAt: string;
  updatedAt: string;
}

interface ProblemsTabProps {
  userProfile: any;
}

export function ProblemsTab({ userProfile }: ProblemsTabProps) {
  // Default to 'user' role if missing or empty
  const userRole = userProfile?.role || 'user';
  const isAdmin = userRole === 'admin';
  console.log('User role:', userRole);
  console.log('Is admin:', isAdmin);

  const [problems, setProblems] = useState<Problem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isAddingProblem, setIsAddingProblem] = useState(false);
  const [selectedProblem, setSelectedProblem] = useState<Problem | null>(null);
  const [newProblem, setNewProblem] = useState({
    title: '',
    description: '',
    difficulty: 'medium' as const,
    language: 'python',
    starterCode: '',
    timeLimit: 5000,
    memoryLimit: 256000
  });

  // Load problems from backend on component mount
  useEffect(() => {
    loadProblems();
  }, []);

  async function loadProblems() {
    try {
      setLoading(true);
      setError(null);
      console.log('Fetching problems from backend...');
      
      const result = await getAllMilestones();
      console.log('Problems loaded:', result);
      
      setProblems(result.milestones || []);
    } catch (err: any) {
      console.error('Failed to load problems:', err);
      setError('Failed to load problems from database');
    } finally {
      setLoading(false);
    }
  }

  const handleAddProblem = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!newProblem.title.trim() || !newProblem.description.trim()) {
      setError('Title and description are required');
      return;
    }

    try {
      setError(null);
      console.log('Creating problem:', newProblem);
      
      const result = await createMilestone(newProblem);
      console.log('Problem created:', result);
      
      setProblems([...problems, result.milestone]);
      setNewProblem({
        title: '',
        description: '',
        difficulty: 'medium',
        language: 'python',
        starterCode: '',
        timeLimit: 5000,
        memoryLimit: 256000
      });
      setIsAddingProblem(false);
    } catch (err: any) {
      console.error('Failed to create problem:', err);
      setError('Failed to create problem. Please try again.');
    }
  };

  const handleDeleteProblem = async (milestoneId: string) => {
    if (!window.confirm('Are you sure you want to delete this problem?')) {
      return;
    }

    try {
      setError(null);
      console.log('Deleting problem:', milestoneId);
      
      await deleteMilestone(milestoneId);
      console.log('Problem deleted successfully');
      
      setProblems(problems.filter(p => p.milestoneId !== milestoneId));
    } catch (err: any) {
      console.error('Failed to delete problem:', err);
      setError('Failed to delete problem. Please try again.');
    }
  };

  const handleOpenEditor = (problem: Problem) => {
    setSelectedProblem(problem);
  };

  const handleCloseEditor = () => {
    setSelectedProblem(null);
  };

  const handleSubmitSuccess = () => {
    // Reload problems to update any stats
    loadProblems();
    // Close editor after a delay
    setTimeout(() => {
      setSelectedProblem(null);
    }, 2000);
  };

  const getDifficultyColor = (difficulty: string) => {
    switch (difficulty) {
      case 'easy':
        return '#28a745';
      case 'medium':
        return '#ffc107';
      case 'hard':
        return '#dc3545';
      default:
        return '#6c757d';
    }
  };

  if (loading) {
    return (
      <div style={{ textAlign: 'center', padding: '40px' }}>
        <p style={{ color: '#333' }}>Loading problems...</p>
      </div>
    );
  }

  return (
    <div style={{ padding: '20px' }}>
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: '20px'
      }}>
        <div>
          <h2 style={{ marginBottom: '10px', color: '#333' }}>Coding Problems</h2>
          <p style={{ color: '#666', margin: 0 }}>
            Total Problems: <strong>{problems.length}</strong>
          </p>
        </div>
        {isAdmin && (
          <button
            onClick={() => {
              setIsAddingProblem(!isAddingProblem);
              setError(null);
            }}
            style={{
              padding: '10px 20px',
              background: '#007bff',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
              fontSize: '14px',
              fontWeight: 'bold'
            }}
          >
            {isAddingProblem ? 'Cancel' : '➕ Add Problem'}
          </button>
        )}
      </div>

      {error && (
        <div style={{
          background: '#f8d7da',
          color: '#721c24',
          padding: '15px',
          borderRadius: '8px',
          marginBottom: '20px',
          border: '1px solid #f5c6cb'
        }}>
          {error}
        </div>
      )}

      {isAdmin && isAddingProblem && (
        <form onSubmit={handleAddProblem} style={{
          background: '#f8f9fa',
          padding: '20px',
          borderRadius: '8px',
          marginBottom: '20px',
          border: '1px solid #dee2e6'
        }}>
          <h3 style={{ color: '#333', marginTop: 0 }}>Create New Problem</h3>
          
          <div style={{ marginBottom: '15px' }}>
            <label style={{ 
              display: 'block', 
              marginBottom: '5px', 
              fontWeight: 'bold',
              color: '#333'
            }}>
              Problem Title:
            </label>
            <input
              type="text"
              value={newProblem.title}
              onChange={(e) => setNewProblem({ ...newProblem, title: e.target.value })}
              placeholder="e.g., Two Sum"
              style={{
                width: '100%',
                padding: '10px',
                fontSize: '14px',
                border: '1px solid #ced4da',
                borderRadius: '4px',
                boxSizing: 'border-box'
              }}
              required
            />
          </div>

          <div style={{ marginBottom: '15px' }}>
            <label style={{ 
              display: 'block', 
              marginBottom: '5px', 
              fontWeight: 'bold',
              color: '#333'
            }}>
              Description:
            </label>
            <textarea
              value={newProblem.description}
              onChange={(e) => setNewProblem({ ...newProblem, description: e.target.value })}
              placeholder="Describe the problem in detail..."
              style={{
                width: '100%',
                padding: '10px',
                fontSize: '14px',
                border: '1px solid #ced4da',
                borderRadius: '4px',
                minHeight: '120px',
                boxSizing: 'border-box',
                fontFamily: 'inherit'
              }}
              required
            />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '15px', marginBottom: '15px' }}>
            <div>
              <label style={{ 
                display: 'block', 
                marginBottom: '5px', 
                fontWeight: 'bold',
                color: '#333'
              }}>
                Difficulty:
              </label>
              <select
                value={newProblem.difficulty}
                onChange={(e) => setNewProblem({ ...newProblem, difficulty: e.target.value as any })}
                style={{
                  width: '100%',
                  padding: '10px',
                  fontSize: '14px',
                  border: '1px solid #ced4da',
                  borderRadius: '4px'
                }}
              >
                <option value="easy">Easy</option>
                <option value="medium">Medium</option>
                <option value="hard">Hard</option>
              </select>
            </div>

            <div>
              <label style={{ 
                display: 'block', 
                marginBottom: '5px', 
                fontWeight: 'bold',
                color: '#333'
              }}>
                Language:
              </label>
              <select
                value={newProblem.language}
                onChange={(e) => setNewProblem({ ...newProblem, language: e.target.value })}
                style={{
                  width: '100%',
                  padding: '10px',
                  fontSize: '14px',
                  border: '1px solid #ced4da',
                  borderRadius: '4px'
                }}
              >
                <option value="python">Python</option>
                <option value="javascript">JavaScript</option>
                <option value="java">Java</option>
                <option value="cpp">C++</option>
                <option value="c">C</option>
              </select>
            </div>
          </div>

          <div style={{ marginBottom: '15px' }}>
            <label style={{ 
              display: 'block', 
              marginBottom: '5px', 
              fontWeight: 'bold',
              color: '#333'
            }}>
              Starter Code (Optional):
            </label>
            <textarea
              value={newProblem.starterCode}
              onChange={(e) => setNewProblem({ ...newProblem, starterCode: e.target.value })}
              placeholder="Leave empty for default template..."
              style={{
                width: '100%',
                padding: '10px',
                fontSize: '13px',
                border: '1px solid #ced4da',
                borderRadius: '4px',
                minHeight: '100px',
                boxSizing: 'border-box',
                fontFamily: 'monospace'
              }}
            />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '15px', marginBottom: '15px' }}>
            <div>
              <label style={{ 
                display: 'block', 
                marginBottom: '5px', 
                fontWeight: 'bold',
                color: '#333'
              }}>
                Time Limit (ms):
              </label>
              <input
                type="number"
                value={newProblem.timeLimit}
                onChange={(e) => setNewProblem({ ...newProblem, timeLimit: parseInt(e.target.value) || 5000 })}
                style={{
                  width: '100%',
                  padding: '10px',
                  fontSize: '14px',
                  border: '1px solid #ced4da',
                  borderRadius: '4px'
                }}
              />
            </div>

            <div>
              <label style={{ 
                display: 'block', 
                marginBottom: '5px', 
                fontWeight: 'bold',
                color: '#333'
              }}>
                Memory Limit (KB):
              </label>
              <input
                type="number"
                value={newProblem.memoryLimit}
                onChange={(e) => setNewProblem({ ...newProblem, memoryLimit: parseInt(e.target.value) || 256000 })}
                style={{
                  width: '100%',
                  padding: '10px',
                  fontSize: '14px',
                  border: '1px solid #ced4da',
                  borderRadius: '4px'
                }}
              />
            </div>
          </div>

          <button
            type="submit"
            style={{
              padding: '10px 20px',
              background: '#28a745',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
              fontSize: '14px',
              fontWeight: 'bold'
            }}
          >
            Create Problem
          </button>
        </form>
      )}

      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(350px, 1fr))',
        gap: '20px'
      }}>
        {problems.map((problem) => (
          <div
            key={problem.milestoneId}
            style={{
              background: 'white',
              border: '2px solid #dee2e6',
              borderRadius: '8px',
              padding: '20px',
              cursor: 'pointer',
              transition: 'all 0.3s ease',
              boxShadow: '0 2px 4px rgba(0,0,0,0.05)'
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.transform = 'translateY(-5px)';
              e.currentTarget.style.boxShadow = '0 4px 12px rgba(0,0,0,0.15)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.transform = 'translateY(0)';
              e.currentTarget.style.boxShadow = '0 2px 4px rgba(0,0,0,0.05)';
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', marginBottom: '10px' }}>
              <h3 style={{
                margin: 0,
                color: '#333',
                fontSize: '18px'
              }}>
                {problem.title}
              </h3>
              <span style={{
                background: getDifficultyColor(problem.difficulty),
                color: 'white',
                padding: '4px 10px',
                borderRadius: '4px',
                fontSize: '12px',
                fontWeight: 'bold',
                textTransform: 'capitalize'
              }}>
                {problem.difficulty}
              </span>
            </div>

            <p style={{
              color: '#666',
              fontSize: '14px',
              marginBottom: '15px',
              lineHeight: '1.5',
              display: '-webkit-box',
              WebkitLineClamp: 3,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden'
            }}>
              {problem.description}
            </p>

            <div style={{
              display: 'flex',
              gap: '8px',
              marginBottom: '15px',
              flexWrap: 'wrap'
            }}>
              {problem.language && (
                <span style={{
                  background: '#e7f3ff',
                  color: '#0066cc',
                  padding: '4px 8px',
                  borderRadius: '4px',
                  fontSize: '12px',
                  fontWeight: 'bold'
                }}>
                  {problem.language.toUpperCase()}
                </span>
              )}
            </div>

            <div style={{
              display: 'flex',
              gap: '10px',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginTop: '15px',
              paddingTop: '15px',
              borderTop: '1px solid #dee2e6'
            }}>
              <small style={{ color: '#999', fontSize: '12px' }}>
                Added: {new Date(problem.createdAt).toLocaleDateString()}
              </small>

              <div style={{ display: 'flex', gap: '10px' }}>
                <button
                  onClick={() => handleOpenEditor(problem)}
                  style={{
                    padding: '8px 16px',
                    background: '#007bff',
                    color: 'white',
                    border: 'none',
                    borderRadius: '4px',
                    cursor: 'pointer',
                    fontSize: '13px',
                    fontWeight: 'bold'
                  }}
                >
                  Solve 💻
                </button>

                {isAdmin && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDeleteProblem(problem.milestoneId);
                    }}
                    style={{
                      padding: '8px 16px',
                      background: '#dc3545',
                      color: 'white',
                      border: 'none',
                      borderRadius: '4px',
                      cursor: 'pointer',
                      fontSize: '13px',
                      fontWeight: 'bold'
                    }}
                  >
                    Delete
                  </button>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>

      {problems.length === 0 && !loading && (
        <div style={{
          textAlign: 'center',
          padding: '60px 20px',
          color: '#999'
        }}>
          <p style={{ fontSize: '18px', marginBottom: '10px' }}>📝 No problems available yet</p>
          <p style={{ fontSize: '14px' }}>
            {isAdmin ? 'Click "Add Problem" to create your first coding challenge!' : 'Check back later for new challenges!'}
          </p>
        </div>
      )}

      {/* Code Editor Modal */}
      {selectedProblem && (
        <CodeEditor
          milestone={selectedProblem}
          onClose={handleCloseEditor}
          onSubmitSuccess={handleSubmitSuccess}
        />
      )}
    </div>
  );
}