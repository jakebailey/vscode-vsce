declare module 'parse-semver' {
	interface Result {
		readonly name: string;
		readonly range: string;
		readonly version: string;
	}
	function parseSemver(input: string): Result;
	export default parseSemver;
}
