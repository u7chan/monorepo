import type { FC, FormEvent } from "react";
import { hc } from "hono/client";

import type { AppType } from "../server";

const client = hc<AppType>("/");

export const Main: FC = () => {
	const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
		e.preventDefault();
		const formData = new FormData(e.currentTarget);
		try {
			const res = await client.api.profile.$post({
				form: {
					name: `${formData.get("name")}`,
					email: `${formData.get("email")}`,
				},
			});
			if (!res.ok) {
				const { error } = (await res.json()) as unknown as {
					error: {
						issues: { message: string; path: string[] }[];
					};
				};
				throw new Error(
					`Validation Error: ${error.issues
						.map(({ message, path }) => `'${path[0]}': ${message}`)
						.join(", ")}`,
				);
			}
		} catch (e: unknown) {
			alert(e instanceof Error && e.message);
		}
	};
	return (
		<>
			<h1>Profile</h1>
			<hr />
			<form onSubmit={handleSubmit}>
				<div>
					<input type="text" name="name" placeholder="name" required />
				</div>
				<div>
					<input type="email" name="email" placeholder="email" required />
				</div>
				<button type="submit">Save</button>
			</form>
		</>
	);
};
