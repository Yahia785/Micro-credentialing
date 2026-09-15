/**
 * Input validation utilities.
 */

function validateRequired(obj, fields) {
  for (const field of fields) {
    if (obj[field] === undefined || obj[field] === null || obj[field] === '') {
      return `${field} is required`;
    }
  }
  return null;
}

function validateEnum(value, fieldName, allowed) {
  if (!allowed.includes(value)) {
    return `${fieldName} must be one of: ${allowed.join(', ')}`;
  }
  return null;
}

function validateMaxLength(value, fieldName, max) {
  if (typeof value === 'string' && value.length > max) {
    return `${fieldName} must not exceed ${max} characters`;
  }
  return null;
}

module.exports = { validateRequired, validateEnum, validateMaxLength };
