import { LinkedInProfile } from '../types';

export const mockProfile: LinkedInProfile = {
  name: 'Drew Raines',
  title: 'Senior Software Developer',
  location: 'United States',
  summary:
    'Experienced software developer with expertise in full-stack development, specializing in modern web technologies and scalable applications.',
  workHistory: [
    {
      company: 'Tech Corp',
      position: 'Senior Software Developer',
      duration: '2 years 3 months',
      startDate: 'Jan 2022',
      endDate: 'present',
      description:
        'Led development of scalable web applications using React, Node.js, and AWS. Managed team of 4 developers.',
      location: 'San Francisco, CA'
    },
    {
      company: 'StartupXYZ',
      position: 'Full Stack Developer',
      duration: '1 year 8 months',
      startDate: 'May 2020',
      endDate: 'Dec 2021',
      description: 'Developed MVP and scaled to production with 50k+ users',
      location: 'Remote'
    }
  ],
  education: [
    {
      institution: 'University of Technology',
      degree: "Bachelor's Degree",
      field: 'Computer Science',
      startYear: '2016',
      endYear: '2020'
    }
  ],
  skills: [
    'JavaScript',
    'TypeScript',
    'React',
    'Node.js',
    'Python',
    'AWS',
    'Docker'
  ],
  connections: 847,
  profileStrength: 92
};
