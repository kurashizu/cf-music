// The rules a username and password have to satisfy, shared by every
// place that accepts them: registration, an admin resetting someone's
// password, and a user changing their own. Kept here rather than in the
// register route that first needed them so a new entry point can't
// accidentally enforce a weaker rule than the one an account was
// originally created under.

export const MIN_USERNAME_LENGTH = 3;
export const MAX_USERNAME_LENGTH = 32;
export const MIN_PASSWORD_LENGTH = 8;

/** The reason a username is unacceptable, or null if it is fine. */
export function usernameProblem(username: string): string | null {
	if (username.length < MIN_USERNAME_LENGTH || username.length > MAX_USERNAME_LENGTH) {
		return `username must be between ${MIN_USERNAME_LENGTH} and ${MAX_USERNAME_LENGTH} characters`;
	}
	return null;
}

/** The reason a password is unacceptable, or null if it is fine. */
export function passwordProblem(password: string): string | null {
	if (password.length < MIN_PASSWORD_LENGTH) {
		return `password must be at least ${MIN_PASSWORD_LENGTH} characters`;
	}
	return null;
}
