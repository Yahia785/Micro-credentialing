const { buildUpdateExpression, RESERVED_WORDS } = require('../db/dynamo-utils');

describe('buildUpdateExpression', () => {
  it('produces a correct SET expression for non-reserved words', () => {
    const result = buildUpdateExpression({ description: 'hello', starterCode: 'print()' });

    expect(result.UpdateExpression).toContain('description = :description');
    expect(result.UpdateExpression).toContain('starterCode = :starterCode');
    expect(result.ExpressionAttributeValues[':description']).toBe('hello');
    expect(result.ExpressionAttributeValues[':starterCode']).toBe('print()');
  });

  it('uses ExpressionAttributeNames for reserved words', () => {
    // NOTE: the task description's example list includes "title", but "title"
    // is not actually present in RESERVED_WORDS (verified against the source).
    // Using words that are actually in the set: status, language, name, role.
    const result = buildUpdateExpression({
      status: 'active',
      language: 'python',
      name: 'Alice',
      role: 'admin',
    });

    expect(result.ExpressionAttributeNames).toEqual({
      '#status': 'status',
      '#language': 'language',
      '#name': 'name',
      '#role': 'role',
    });
    expect(result.UpdateExpression).toContain('#status = :status');
    expect(result.UpdateExpression).toContain('#language = :language');
    expect(result.UpdateExpression).toContain('#name = :name');
    expect(result.UpdateExpression).toContain('#role = :role');
    expect(result.ExpressionAttributeValues[':status']).toBe('active');
    expect(result.ExpressionAttributeValues[':language']).toBe('python');
    expect(result.ExpressionAttributeValues[':name']).toBe('Alice');
    expect(result.ExpressionAttributeValues[':role']).toBe('admin');
  });

  it('documents that "title" is NOT treated as a reserved word', () => {
    // This test exists to make the actual (surprising) behavior explicit and
    // regression-proof, given the task description listed "title" as reserved.
    expect(RESERVED_WORDS.has('title')).toBe(false);

    const result = buildUpdateExpression({ title: 'My Milestone' });
    expect(result.UpdateExpression).toContain('title = :title');
    expect(result.ExpressionAttributeNames).toBeUndefined();
  });

  it('always includes updatedAt automatically', () => {
    const result = buildUpdateExpression({ description: 'hello' });

    expect(result.UpdateExpression).toContain('updatedAt = :updatedAt');
    expect(result.ExpressionAttributeValues[':updatedAt']).toEqual(expect.any(String));
    // Should be a valid ISO timestamp
    expect(new Date(result.ExpressionAttributeValues[':updatedAt']).toString()).not.toBe('Invalid Date');
  });

  it('handles a mix of reserved and non-reserved words together', () => {
    const result = buildUpdateExpression({ description: 'hello', status: 'active' });

    expect(result.UpdateExpression).toContain('description = :description');
    expect(result.UpdateExpression).toContain('#status = :status');
    expect(result.ExpressionAttributeNames).toEqual({ '#status': 'status' });
    expect(result.ExpressionAttributeValues[':description']).toBe('hello');
    expect(result.ExpressionAttributeValues[':status']).toBe('active');
  });

  it('still produces updatedAt when the updates object is empty', () => {
    const result = buildUpdateExpression({});

    expect(result.UpdateExpression).toBe('SET updatedAt = :updatedAt');
    expect(result.ExpressionAttributeValues[':updatedAt']).toEqual(expect.any(String));
    expect(result.ExpressionAttributeNames).toBeUndefined();
  });

  it('skips keys whose value is undefined', () => {
    const result = buildUpdateExpression({ description: undefined, score: 90 });

    expect(result.UpdateExpression).not.toContain(':description');
    expect(result.ExpressionAttributeValues[':description']).toBeUndefined();
    // score IS reserved
    expect(result.ExpressionAttributeValues[':score']).toBe(90);
  });

  it('leaves ExpressionAttributeNames undefined (not {}) when no reserved words are used', () => {
    const result = buildUpdateExpression({ description: 'hello', starterCode: 'x' });

    expect(result.ExpressionAttributeNames).toBeUndefined();
  });
});
